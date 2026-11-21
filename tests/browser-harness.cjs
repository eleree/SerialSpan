const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const SerialData = require('../static/js/serial-data.js');
const SerialConfig = require('../static/js/serial-config.js');
const RxReplay = require('../static/js/rx-replay.js');
const SerialTools = require('../static/js/serial-tools.js');

class Element {
    constructor() {
        this.children = [];
        this.listeners = {};
        this.value = '';
        this.checked = false;
        this.disabled = false;
        this.dataset = {};
        this._text = '';
        const classes = new Set();
        this.classList = {
            add: name => classes.add(name), remove: name => classes.delete(name),
            toggle: (name, force) => {
                const enabled = force === undefined ? !classes.has(name) : force;
                if (enabled) classes.add(name); else classes.delete(name);
                return enabled;
            },
            replace: (oldName, name) => { classes.delete(oldName); classes.add(name); },
            contains: name => classes.has(name)
        };
    }
    set textContent(value) { this._text = value; this.replaceChildren(); }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    get firstChild() { return this.children[0]; }
    get options() { return this.children; }
    appendChild(child) { child.parent = this; this.children.push(child); return child; }
    append(...children) { children.forEach(child => this.appendChild(child)); }
    replaceChildren(...children) { this.children = []; children.forEach(child => this.appendChild(child)); }
    remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); }
    addEventListener(type, listener) { this.listeners[type] = listener; }
    setAttribute(name, value) { this.attributes ||= {}; this.attributes[name] = String(value); }
    removeAttribute(name) { delete this.attributes?.[name]; }
    click() { this.listeners.click?.(); }
}

function browser(script, options = {}) {
    const elements = new Map();
    const sockets = [];
    const timers = [];
    const historyCalls = [];
    const storage = options.storage || new Map();
    const html = fs.readFileSync(path.join(__dirname, '../static/', script.replace(/\.js$/, '.html')), 'utf8');
    const defaults = new Map();
    for (const select of html.matchAll(/<select\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) {
        if (!SerialConfig.fields.includes(select[1])) continue;
        const options = [...select[2].matchAll(/<option\b([^>]*)>([^<]*)<\/option>/g)];
        const option = options.find(item => /\bselected\b/.test(item[1])) || options[0];
        if (option) defaults.set(select[1], option[1].match(/\bvalue="([^"]*)"/)?.[1] ?? option[2]);
    }
    const presets = [...html.matchAll(/<button data-cmd="([^"]+)">/g)].map(match => {
        const button = new Element();
        button.dataset.cmd = match[1];
        return button;
    });
    class Socket {
        static OPEN = 1;
        static CLOSED = 3;
        constructor(url) { this.url = url; this.readyState = 1; this.messages = []; sockets.push(this); }
        send(data) { this.messages.push(JSON.parse(data)); }
        close() { this.readyState = 3; this.onclose?.(); }
    }
    const sandbox = {
        document: {
            getElementById(id) { if (!elements.has(id)) { const element = new Element(); element.value = defaults.get(id) || ''; elements.set(id, element); } return elements.get(id); },
            createElement: () => new Element(),
            querySelectorAll: () => presets,
            body: new Element()
        },
        location: { protocol: 'https:', host: 'localhost:12345', pathname: '/remote' },
        navigator: { serial: {}, clipboard: { writeText: async () => {} } },
        localStorage: {
            getItem(key) { return storage.has(key) ? storage.get(key) : null; },
            setItem(key, value) { storage.set(String(key), String(value)); },
            removeItem(key) { storage.delete(String(key)); },
            clear() { storage.clear(); }
        },
        isSecureContext: true, WebSocket: Socket,
        SerialData, SerialConfig, RxReplay, SerialTools, Uint8Array, TextEncoder, TextDecoder, Blob, URL,
        crypto: webcrypto,
        console,
        setTimeout: (callback, delay) => { const timer = { callback, delay, cancelled: false }; timers.push(timer); return timer; },
        clearTimeout: timer => { if (timer) timer.cancelled = true; },
        requestAnimationFrame: callback => callback(),
        addEventListener: (type, callback) => {
            if (type === 'DOMContentLoaded') sandbox.initialize = callback;
            else (sandbox.windowListeners ||= {})[type] = callback;
        }
    };
    sandbox.historyCalls = historyCalls;
    sandbox.history = { pushState(state, title, url) { sandbox.location.pathname = url; historyCalls.push(url); } };
    sandbox.window = sandbox;
    const context = vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../static/js/', script), 'utf8'), context, { filename: script });
    if (script === 'local.js') vm.runInContext(fs.readFileSync(path.join(__dirname, '../static/js/local-config.js'), 'utf8'), context, { filename: 'local-config.js' });
    return { sandbox, elements, sockets, timers, presets, storage, historyCalls, run: code => vm.runInContext(code, context) };
}

module.exports = { browser, Element };
