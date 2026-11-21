// Shared byte conversions. No framework or runtime dependency is required.
(function (root) {
    const MAX_SEND_BYTES = 16384;

    function toBase64(bytes) {
        let binary = '';
        for (const byte of bytes) binary += String.fromCharCode(byte);
        return btoa(binary);
    }

    function fromBase64(value) {
        return Uint8Array.from(atob(value), letter => letter.charCodeAt(0));
    }

    function formatHex(bytes) {
        return Array.from(bytes, byte => byte.toString(16).padStart(2, '0').toUpperCase()).join(' ');
    }

    function parseSendInput(value, hex, appendCR) {
        let bytes;
        if (hex) {
            const compact = value.replace(/\s/g, '');
            if (!compact || compact.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(compact)) {
                throw new Error('HEX 必须是完整的十六进制字节，例如 01 AF 0D');
            }
            bytes = Uint8Array.from(compact.match(/../g), pair => parseInt(pair, 16));
        } else {
            bytes = new TextEncoder().encode(value);
        }
        if (appendCR) {
            const result = new Uint8Array(bytes.length + 1);
            result.set(bytes);
            result[bytes.length] = 0x0D;
            bytes = result;
        }
        if (bytes.length > MAX_SEND_BYTES) throw new Error('单次发送最多 16 KiB');
        return bytes;
    }

    const api = { MAX_SEND_BYTES, toBase64, fromBase64, formatHex, parseSendInput };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.SerialData = api;
})(globalThis);
