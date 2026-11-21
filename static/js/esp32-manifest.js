// Browser-side ESP32-C3/S3 manifest validation before serial bytes are relayed to Local.
(function (root) {
    'use strict';

    const FORMAT = 'shareserial-esp32-images-v1';
    const MAX_IMAGES = 8;
    const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
    const FLASH_SIZES = Object.freeze({
        '256KB': 256 * 1024, '512KB': 512 * 1024, '1MB': 1024 * 1024,
        '2MB': 2 * 1024 * 1024, '2MB-c1': 2 * 1024 * 1024,
        '4MB': 4 * 1024 * 1024, '4MB-c1': 4 * 1024 * 1024,
        '8MB': 8 * 1024 * 1024, '16MB': 16 * 1024 * 1024,
        '32MB': 32 * 1024 * 1024, '64MB': 64 * 1024 * 1024,
        '128MB': 128 * 1024 * 1024
    });
    const FLASH_MODES = new Set(['dio', 'qio', 'dout', 'qout']);
    const FLASH_FREQUENCIES = new Set(['80m', '60m', '48m', '40m', '30m', '26m', '24m', '20m', '16m', '15m', '12m']);

    function fail(message) { throw new Error(message); }

    function exactKeys(value, allowed, label) {
        for (const key of Object.keys(value)) {
            if (!allowed.has(key)) fail(label + ' 包含不支持的字段：' + key);
        }
    }

    function normalizedChip(value) {
        if (typeof value !== 'string') return '';
        const upper = value.toUpperCase().replace(/\s+/g, '-');
        if (/ESP32-C3(?:\b|-)/.test(upper)) return 'ESP32-C3';
        if (/ESP32-S3(?:\b|-)/.test(upper)) return 'ESP32-S3';
        return upper;
    }

    function parseAddress(value) {
        if (typeof value !== 'string' || !/^0x[0-9a-f]{1,8}$/i.test(value)) {
            fail('镜像地址必须是 0x 开头的 32 位十六进制数');
        }
        const address = Number.parseInt(value.slice(2), 16);
        if (!Number.isSafeInteger(address) || address % 4096 !== 0) {
            fail('镜像地址必须按 4 KiB 对齐');
        }
        return address;
    }

    function parse(text) {
        let value;
        try { value = JSON.parse(text); }
        catch { fail('固件清单不是有效 JSON'); }
        if (!value || Array.isArray(value) || typeof value !== 'object') fail('固件清单必须是 JSON 对象');
        exactKeys(value, new Set(['format', 'chip', 'version', 'flashMode', 'flashFreq', 'flashSize', 'images']), '固件清单');
        if (value.format !== FORMAT) fail('不支持的固件清单格式');
        if (!['ESP32-C3', 'ESP32-S3'].includes(value.chip)) fail('chip 必须是 ESP32-C3 或 ESP32-S3');
        if (typeof value.version !== 'string' || !value.version.trim() || value.version.length > 80) fail('固件版本必须是 1–80 字符');
        if (!FLASH_MODES.has(value.flashMode)) fail('flashMode 必须是 dio、qio、dout 或 qout');
        if (!FLASH_FREQUENCIES.has(value.flashFreq)) fail('flashFreq 不受支持');
        if (value.flashSize !== 'detect' && !Object.hasOwn(FLASH_SIZES, value.flashSize)) fail('flashSize 必须是 detect 或清单支持的容量');
        if (!Array.isArray(value.images) || value.images.length < 1 || value.images.length > MAX_IMAGES) {
            fail('images 必须包含 1–' + MAX_IMAGES + ' 个镜像');
        }

        const names = new Set();
        const images = value.images.map((image, index) => {
            if (!image || Array.isArray(image) || typeof image !== 'object') fail('第 ' + (index + 1) + ' 个镜像描述无效');
            exactKeys(image, new Set(['file', 'address', 'sha256']), '第 ' + (index + 1) + ' 个镜像描述');
            if (typeof image.file !== 'string' || !image.file || image.file.length > 128 ||
                image.file === '.' || image.file === '..' || /[\\/\u0000-\u001f]/.test(image.file) || !/\.bin$/i.test(image.file)) {
                fail('镜像文件必须是纯文件名且以 .bin 结尾');
            }
            const fileKey = image.file.toLowerCase();
            if (names.has(fileKey)) fail('镜像文件名不能重复：' + image.file);
            names.add(fileKey);
            if (typeof image.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(image.sha256)) fail(image.file + ' 缺少有效的 SHA-256');
            return { file: image.file, address: parseAddress(image.address), sha256: image.sha256.toLowerCase() };
        });
        return { format: FORMAT, chip: value.chip, version: value.version.trim(),
            flashMode: value.flashMode, flashFreq: value.flashFreq, flashSize: value.flashSize, images };
    }

    function parseDetectedFlashSize(value) {
        return typeof value === 'string' && Object.hasOwn(FLASH_SIZES, value) ? FLASH_SIZES[value] : 0;
    }

    function bytesToHex(value) {
        return Array.from(new Uint8Array(value), byte => byte.toString(16).padStart(2, '0')).join('');
    }

    async function prepareManual(layout, selectedFiles, detectedChip, detectedFlashSize, settings, digest) {
        // Use the same strict address/schema validation as imported manifests.
        // Manual hashes describe the selected bytes; there is no publisher hash to compare.
        if (!Array.isArray(layout) || !settings) fail('请选择镜像并设置写入地址与 Flash 参数');
        if (!digest && !root.crypto?.subtle) fail('此浏览器缺少 Web Crypto，无法计算固件 SHA-256');
        const parsed = parse(JSON.stringify({ format: FORMAT, chip: normalizedChip(detectedChip),
            version: 'manual-images', flashMode: settings.flashMode, flashFreq: settings.flashFreq,
            flashSize: detectedFlashSize,
            images: layout.map(image => ({ file: image.file, address: image.address, sha256: '0'.repeat(64) })) }));
        const files = Array.from(selectedFiles || []);
        const byName = new Map(files.map(file => [file.name.toLowerCase(), file]));
        if (byName.size !== files.length || files.length !== parsed.images.length) fail('文件与所选烧录行不一致或文件名重复');
        const cachedFiles = [];
        let totalBytes = 0;
        for (const descriptor of parsed.images) {
            const file = byName.get(descriptor.file.toLowerCase());
            if (!file || !Number.isSafeInteger(file.size) || file.size <= 0) fail('缺少镜像文件或文件为空：' + descriptor.file);
            totalBytes += file.size;
            if (totalBytes > MAX_TOTAL_BYTES) fail('镜像总大小不能超过 32 MiB');
            if (descriptor.address + file.size > parseDetectedFlashSize(detectedFlashSize)) fail(descriptor.file + ' 超出设备 Flash 容量');
            const data = new Uint8Array(await file.arrayBuffer());
            if (data.length !== file.size) fail(descriptor.file + ' 读取长度与文件大小不一致');
            descriptor.sha256 = digest ? await digest(data) : bytesToHex(await root.crypto.subtle.digest('SHA-256', data));
            cachedFiles.push({ name: file.name, size: data.length, arrayBuffer: async () => data.slice().buffer });
        }
        const result = await verify(parsed, cachedFiles, detectedChip, detectedFlashSize, digest);
        return { ...result, hashMode: 'computed' };
    }

    async function verify(parsed, selectedFiles, detectedChip, detectedFlashSize, digest) {
        if (!parsed || parsed.format !== FORMAT) fail('请先加载有效的 ShareSerial ESP32 镜像清单');
        if (normalizedChip(detectedChip) !== parsed.chip) fail('板卡芯片与清单不匹配：设备 ' + normalizedChip(detectedChip) + '，清单 ' + parsed.chip);
        const flashBytes = parseDetectedFlashSize(detectedFlashSize);
        if (!flashBytes) fail('无法检测 Flash 容量，拒绝继续烧录');
        if (parsed.flashSize !== 'detect' && parsed.flashSize !== detectedFlashSize) {
            fail('清单 Flash 容量与设备不匹配：设备 ' + detectedFlashSize + '，清单 ' + parsed.flashSize);
        }

        const files = Array.from(selectedFiles || []);
        const byName = new Map();
        for (const file of files) {
            const key = String(file.name || '').toLowerCase();
            if (!key || byName.has(key)) fail('所选文件中存在空名称或重复文件名：' + (file.name || ''));
            byName.set(key, file);
        }
        const expectedNames = new Set(parsed.images.map(image => image.file.toLowerCase()));
        for (const file of files) {
            if (!expectedNames.has(String(file.name || '').toLowerCase())) fail('所选文件未列在清单中：' + file.name);
        }
        const hashFile = digest || (async bytes => {
            if (!root.crypto?.subtle) fail('此浏览器缺少 Web Crypto，无法校验固件 SHA-256');
            return bytesToHex(await root.crypto.subtle.digest('SHA-256', bytes));
        });

        let totalBytes = 0;
        const images = [];
        for (const descriptor of parsed.images) {
            const file = byName.get(descriptor.file.toLowerCase());
            if (!file) fail('缺少清单镜像文件：' + descriptor.file);
            if (!Number.isSafeInteger(file.size) || file.size <= 0) fail(descriptor.file + ' 为空或大小无效');
            totalBytes += file.size;
            if (totalBytes > MAX_TOTAL_BYTES) fail('镜像总大小不能超过 32 MiB');
            const end = descriptor.address + file.size;
            if (end > flashBytes) fail(descriptor.file + ' 超出设备 Flash 容量');
            const data = new Uint8Array(await file.arrayBuffer());
            if (data.length !== file.size) fail(descriptor.file + ' 读取长度与文件大小不一致');
            const actualHash = String(await hashFile(data)).toLowerCase();
            if (actualHash !== descriptor.sha256) fail(descriptor.file + ' 的 SHA-256 与清单不一致');
            images.push({ ...descriptor, size: file.size, end, data });
        }

        const ordered = [...images].sort((left, right) => left.address - right.address);
        for (let i = 1; i < ordered.length; i++) {
            if (ordered[i].address < ordered[i - 1].end) fail('镜像写入范围重叠：' + ordered[i - 1].file + ' / ' + ordered[i].file);
        }
        return { ...parsed, flashSize: detectedFlashSize, flashBytes, totalBytes, images,
            fileArray: images.map(image => ({ data: image.data, address: image.address })) };
    }

    const api = { FORMAT, MAX_IMAGES, MAX_TOTAL_BYTES, FLASH_SIZES, parse, parseAddress,
        parseDetectedFlashSize, normalizedChip, verify, prepareManual };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    root.ShareSerialESP32Manifest = api;
})(globalThis);
