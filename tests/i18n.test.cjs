const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class TextNode {
    constructor(value, parentElement) { this.nodeType = 3; this.nodeValue = value; this.parentElement = parentElement; }
}

class Element {
    constructor(tagName, attrs = {}) {
        this.nodeType = 1;
        this.tagName = tagName.toUpperCase();
        this.attributes = new Map(Object.entries(attrs));
        this.childNodes = [];
        this.parentElement = null;
    }
    append(child) { child.parentElement = this; this.childNodes.push(child); return child; }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    closest(selector) {
        const selectors = selector.split(',').map(value => value.trim());
        for (let node = this; node; node = node.parentElement) {
            for (const item of selectors) {
                if (item.startsWith('.') && (node.getAttribute('class') || '').split(/\s+/).includes(item.slice(1))) return node;
                if (item.startsWith('[role=') && node.getAttribute('role') === item.slice(7, -2)) return node;
                if (!item.startsWith('.') && !item.startsWith('[') && node.tagName.toLowerCase() === item) return node;
            }
        }
        return null;
    }
}

function loadI18n(languages) {
    const html = new Element('html');
    const head = html.append(new Element('head'));
    const title = head.append(new Element('title'));
    title.append(new TextNode('ShareSerial - 本地串口助手', title));
    const body = html.append(new Element('body'));
    const button = body.append(new Element('button', { title: '选择串口' }));
    button.append(new TextNode('打开串口', button));
    const terminal = body.append(new Element('div', { class: 'terminal', role: 'log' }));
    const serialText = terminal.append(new TextNode('串口已打开', terminal));
    const document = {
        readyState: 'complete', documentElement: html, title: 'ShareSerial - 本地串口助手',
        createTreeWalker(rootNode) {
            const nodes = [];
            const visit = node => { for (const child of node.childNodes || []) { nodes.push(child); if (child.nodeType === 1) visit(child); } };
            visit(rootNode);
            let index = 0;
            return { nextNode: () => nodes[index++] || null };
        }
    };
    class MutationObserver { observe() {} }
    const context = vm.createContext({ document, navigator: { languages, language: languages[0] }, MutationObserver });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../static/js/i18n.js'), 'utf8'), context);
    return { i18n: context.ShareSerialI18n, html, title, button, serialText, context };
}

test('browser language automatically selects English or Chinese and updates document lang', () => {
    const english = loadI18n(['en-US', 'zh-CN']);
    assert.equal(english.i18n.language, 'en');
    assert.equal(english.html.getAttribute('lang'), null);
    assert.equal(english.html.lang, 'en');
    assert.equal(english.title.childNodes[0].nodeValue, 'ShareSerial - Local Serial');
    assert.equal(english.button.childNodes[0].nodeValue, 'Open port');
    assert.equal(english.button.getAttribute('title'), 'Select port');
    assert.equal(english.i18n.text('串口已打开：115200 baud，数据位 8，停止位 1，校验 none，流控 none'),
        'Serial port opened: 115200 baud, 8 data bits, 1 stop bit, parity none, flow control none.');
});

test('Chinese remains the source language and serial log payloads are not translated in English mode', () => {
    const chinese = loadI18n(['zh-CN', 'en-US']);
    assert.equal(chinese.i18n.language, 'zh');
    assert.equal(chinese.html.lang, 'zh-CN');
    assert.equal(chinese.title.childNodes[0].nodeValue, 'ShareSerial - 本地串口助手');
    const english = loadI18n(['en-GB']);
    assert.equal(english.serialText.nodeValue, '串口已打开');
});

test('dynamic reconnect, P2P, network and flashing statuses translate in English mode', () => {
    const { i18n } = loadI18n(['en-US']);
    const messages = [
        '服务器连接已断开（代码 1006），3 秒后重连。',
        '连接断开，5 秒后自动重连并重新申请权限',
        '正在协商直连；直连尝试 1/4；已配置 STUN；ICE=checking；本端 host=1 srflx=0 relay=0；对端 host=1 srflx=1 relay=0',
        '共享网络参考（服务器）：暂无法给出参考波特率',
        '有效接收 2.11 Mbps · 往返中位 20 ms · 探测超时率 10%（1/10），失败共 1/10。部分探测失败，结果仅供临时参考。更新于 12:34:56',
        'ESP32 烧录会话正在独占串口；请等待结束后再发送'
    ];
    for (const message of messages) assert.doesNotMatch(i18n.text(message), /[\u3400-\u9fff]/, message + ' was only partially translated');
});
