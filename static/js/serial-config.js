(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.SerialConfig = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    const fields = ['baudRate', 'dataBits', 'stopBits', 'parity', 'flowControl'];
    function valid(config) {
        return !!config && [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600].includes(config.baudRate) &&
            [7, 8].includes(config.dataBits) && [1, 2].includes(config.stopBits) &&
            ['none', 'odd', 'even'].includes(config.parity) && ['none', 'hardware'].includes(config.flowControl);
    }
    function read(elements) {
        const config = { baudRate: Number(elements.baudRate.value), dataBits: Number(elements.dataBits.value),
            stopBits: Number(elements.stopBits.value), parity: elements.parity.value, flowControl: elements.flowControl.value };
        if (!valid(config)) throw new Error('请选择有效的串口参数');
        return config;
    }
    function display(elements, config) {
        if (!valid(config)) return;
        for (const field of fields) elements[field].value = String(config[field]);
    }
    function describe(config) {
        if (!valid(config)) return '未知参数';
        const parity = { none: 'N', odd: 'O', even: 'E' }[config.parity];
        return config.baudRate + ' baud · ' + config.dataBits + parity + config.stopBits + ' · ' +
            (config.flowControl === 'hardware' ? 'RTS/CTS' : '无流控');
    }
    return { valid, read, display, describe, fields };
});
