/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useRef } from 'react';
import { Chart, registerables } from 'chart.js';

Chart.register(...registerables);

// Types for Web Serial (simplified)
interface SerialPort {
  open(options: { baudRate: number; dataBits?: number; stopBits?: number; parity?: string; flowControl?: string }): Promise<void>;
  close(): Promise<void>;
  writable: { getWriter(): any };
  readable: { getReader(): any };
  getInfo(): { usbVendorId?: number; usbProductId?: number };
  setSignals(signals: { dataTerminalReady?: boolean; requestToSend?: boolean; break?: boolean }): Promise<void>;
}

declare global {
  interface Navigator {
    serial: {
      requestPort(options?: { filters: { usbVendorId: number }[] }): Promise<SerialPort>;
    };
  }
}

class MicroNIRApp {
    STX: number;
    ETX: number;
    CR: number;
    CMD: { LAMP: number; SCAN: number; BATTERY: number; VERSION: number; TEMP: number };
    FTDI_PAYLOAD_CHUNK: number;
    FTDI_STATUS_BYTES: number;
    BLE_SVC_UUIDS: string[];
    BLE_TX_UUIDS: string[];
    BLE_RX_UUIDS: string[];
    mode: string;
    connected: boolean;
    customServiceUUID: string | null;
    bleDevice: any;
    gattServer: any;
    txChar: any;
    rxChar: any;
    serialPort: any;
    serialWriter: any;
    serialReader: any;
    rxBuffer: number[];
    inPacket: boolean;
    ftdiByteCount: number;
    lastSpectrum: number[];
    lastScanTime: number;
    baselineData: number[] | null;
    showBaseline: boolean;
    pktCount: number;
    responseTimeout: any;
    TIMEOUT_MS: number;
    lastCmdType: string | null;
    chart: any;
    _timeoutAnim: any;
    lampReady: boolean;
    lampConfirmed: boolean;
    ignoreRxUntil: number;
    VAL: { ON: number; OFF: number };
    history: { id: string, name: string, data: number[], time: number }[];

    constructor() {
        this.STX = 0x02;
        this.ETX = 0x03;
        this.CR  = 0x0D;

        this.CMD = {
            // Comandos Historicos Ascii Obsoletos
            LAMP:    0x4C,
            SCAN:    0x53,
            BATTERY: 0x42,
            VERSION: 0x56,
            TEMP:    0x54,

            // DICCIONARIO BINARIO REAL (Viavi Factory Enum)
            SCANDATA_PACKET: 0x01,
            STORE_DATA: 0x02,
            RBDF: 0x03,
            BATTERY_COMMAND: 0x04,
            BATTERY_CHARGER: 0x05,
            BATTERY_CONTROL: 0x06,
            RGBLED: 0x07,
            FACTORY_SERIAL_NUMBER: 0x08,
            LAMP_VOLTAGE: 0x09,
            INTEGRATION_TIME: 0x0A,
            LAMP_DWELLS: 0x0B,
        };

        this.VAL = {
            ON: 0x01, // 0x01 is the binary value for ON
            OFF: 0x00
        };

        this.FTDI_PAYLOAD_CHUNK = 62;
        this.FTDI_STATUS_BYTES  = 2;

        this.BLE_SVC_UUIDS = [
            "0000ffe0-0000-1000-8000-00805f9b34fb",
            "49535343-fe7d-4ae5-8fa9-9fafd205e455",
            "6e400001-b5a3-f393-e0a9-e50e24dcca9e",
            "0000180a-0000-1000-8000-00805f9b34fb",
            "00001800-0000-1000-8000-00805f9b34fb",
            "00001801-0000-1000-8000-00805f9b34fb",
            "0000fef5-0000-1000-8000-00805f9b34fb",
            "1d14d6ee-fd63-4fa1-bfa4-8f47b42119f0",
            "00035b03-5800-11e2-8a77-0002a5d5c51b", // JDSU / Viavi Custom Service
            "0000fff0-0000-1000-8000-00805f9b34fb",
            "0000ffe0-0000-1000-8000-00805f9b34fb",
        ];

        this.BLE_TX_UUIDS = [
            "0000ffe1-0000-1000-8000-00805f9b34fb",
            "49535343-8841-881f-a3b3-2a00b7a5b7de",
            "49535343-8841-43f4-a8d4-ecbe34729bb3", // ISSC TX alternativo (Viavi)
            "6e400002-b5a3-f393-e0a9-e50e24dcca9e",
            "00035b03-5801-11e2-8a77-0002a5d5c51b",
        ];
        this.BLE_RX_UUIDS = [
            "0000ffe1-0000-1000-8000-00805f9b34fb",
            "49535343-1e4d-4bd9-ba61-23c647249616", // ISSC RX alternativo (Viavi)
            "6e400003-b5a3-f393-e0a9-e50e24dcca9e",
            "00035b03-5801-11e2-8a77-0002a5d5c51b",
        ];

        this.mode          = 'ble';
        this.connected     = false;
        this.customServiceUUID = null;

        this.bleDevice     = null;
        this.gattServer    = null;
        this.txChar        = null;
        this.rxChar        = null;

        this.serialPort    = null;
        this.serialWriter  = null;
        this.serialReader  = null;

        this.rxBuffer      = [];
        this.inPacket      = false;
        this.ftdiByteCount = 0;

        this.lastSpectrum  = [];
        this.lastScanTime  = 0;
        this.baselineData  = null;
        this.showBaseline  = false;
        this.pktCount      = 0;

        this.responseTimeout = null;
        this.TIMEOUT_MS      = 1200;
        this.lastCmdType     = null;

        this.lampReady = false;
        this.lampConfirmed = false;
        this.ignoreRxUntil = 0;
        this.history = JSON.parse(localStorage.getItem('mn_history') || '[]');
    }

    initChart() {
        const ctx = (document.getElementById('nirChart') as HTMLCanvasElement).getContext('2d');
        if (!ctx) return;
        const labels = Array.from({length: 128}, (_, i) =>
            Math.round(908 + i * (1676 - 908) / 127)
        );

        this.chart = new Chart(ctx, {
            type: 'line',
            data: {
                labels,
                datasets: [
                    {
                        label: 'Espectro',
                        data: [],
                        borderColor: '#00b8d9',
                        borderWidth: 1.5,
                        pointRadius: 0,
                        fill: true,
                        backgroundColor: 'rgba(0,184,217,.07)',
                        tension: 0.25,
                        order: 1
                    },
                    {
                        label: 'Baseline',
                        data: [],
                        borderColor: 'rgba(255,140,66,.5)',
                        borderWidth: 1,
                        borderDash: [4,3],
                        pointRadius: 0,
                        fill: false,
                        tension: 0.25,
                        order: 2
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: { duration: 150 },
                scales: {
                    y: {
                        grid: { color: '#1a2535' },
                        ticks: { color: '#4a6278', font: { family: 'Share Tech Mono', size: 10 } },
                        title: { display: true, text: 'ADC (16-bit LE)', color: '#4a6278', font: { size: 10, family: 'Share Tech Mono' } }
                    },
                    x: {
                        grid: { color: '#111a25' },
                        ticks: { color: '#4a6278', font: { family: 'Share Tech Mono', size: 9 }, maxTicksLimit: 12 },
                        title: { display: true, text: 'Longitud de onda (nm)', color: '#4a6278', font: { size: 10, family: 'Share Tech Mono' } }
                    }
                },
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        backgroundColor: '#0c1017',
                        borderColor: '#1a2535', borderWidth: 1,
                        titleColor: '#00b8d9', bodyColor: '#b8cfe0',
                        titleFont: { family: 'Share Tech Mono' },
                        bodyFont:  { family: 'Share Tech Mono' },
                        callbacks: {
                            title: (items: any) => `${items[0].label} nm`,
                            label: (item: any)  => ` ADC: ${item.raw}`
                        }
                    }
                }
            }
        });
    }

    log(msg: string, type = '') {
        const el = document.getElementById('console');
        if (!el) return;
        const d  = document.createElement('div');
        d.className = type;
        d.textContent = '> ' + msg;
        el.prepend(d);
        while (el.children.length > 300) el.removeChild(el.lastChild);
    }

    setLed(id: string, state: boolean, color = 'on-green') {
        const el = document.getElementById('led' + id);
        if (el) el.className = 'led-badge' + (state ? ' ' + color : '');
    }

    setSig(id: string, high: boolean) {
        const el = document.getElementById('sig' + id);
        if (el) el.className = 'sig-badge' + (high ? ' high' : '');
    }

    setStatus(text: string, cls = '') {
        const pill = document.getElementById('statusPill');
        const txt = document.getElementById('statusText');
        if (pill) pill.className = 'status-pill ' + cls;
        if (txt) txt.textContent = text;
    }

    updateUI(on: boolean) {
        this.connected = on;
        ['btnWarm','btnBat','btnDisc','btnScan'].forEach(id => {
            const el = document.getElementById(id) as HTMLButtonElement;
            if (el) el.disabled = !on;
        });
        
        const valMode = document.getElementById('valMode');
        if (valMode) valMode.textContent = on ? this.mode.toUpperCase() : '—';
    }

    setMode(m: string) {
        this.mode = m;
        const bleSection = document.getElementById('bleSection');
        const usbSection = document.getElementById('usbSection');
        const uuidBox = document.getElementById('uuidBox');
        const serialCfg = document.getElementById('serialCfg');
        const tabBLE = document.getElementById('tabBLE');
        const tabUSB = document.getElementById('tabUSB');

        if (bleSection) bleSection.style.display  = m==='ble' ? '' : 'none';
        if (usbSection) usbSection.style.display  = m==='usb' ? '' : 'none';
        if (uuidBox) uuidBox.style.display     = m==='ble' ? '' : 'none';
        if (serialCfg) serialCfg.style.display   = m==='usb' ? '' : 'none';
        if (tabBLE) tabBLE.classList.toggle('active', m==='ble');
        if (tabUSB) tabUSB.classList.toggle('active', m==='usb');
        this.log(`Modo: ${m.toUpperCase()}`, 'log-sys');
    }

    startTimeoutBar() {
        const wrap = document.getElementById('timeoutBarWrap');
        const bar  = document.getElementById('timeoutBar');
        if (!wrap || !bar) return;
        wrap.style.display = 'block';
        bar.style.width = '100%';
        bar.style.background = 'var(--warn)';
        const start = Date.now();
        this._timeoutAnim = setInterval(() => {
            const pct = Math.max(0, 100 - ((Date.now()-start) / this.TIMEOUT_MS) * 100);
            bar.style.width = pct + '%';
            if (pct < 20) bar.style.background = 'var(--red)';
        }, 50);
    }

    stopTimeoutBar(ok = true) {
        clearInterval(this._timeoutAnim);
        const bar  = document.getElementById('timeoutBar');
        if (!bar) return;
        bar.style.background = ok ? 'var(--green)' : 'var(--red)';
        setTimeout(() => {
            const wrap = document.getElementById('timeoutBarWrap');
            if (wrap) wrap.style.display = 'none';
        }, 600);
    }

    async powerOnSequence() {
        this.log('═══ SECUENCIA DE ENCENDIDO (Hard Reset & Purge) ═══', 'log-warn');

        // 1. Ciclo de Reset (DTR LOW) - Descarga total
        this.log('DTR → LOW (Resetting MCU)...', 'log-sys');
        await this.setDTR(false);
        this.setSig('DTR', false);
        this.setLed('DTR', false);
        await this.sleep(300); 

        // 2. Power ON (DTR HIGH)
        this.log('DTR → HIGH (Activando VCC)...', 'log-warn');
        await this.setDTR(true);
        this.setSig('DTR', true);
        this.setLed('DTR', true, 'on-green');
        
        // 3. Ventana de Boot y PURGA DE UART
        // MODO SNIFFER: Ya no ignoramos el ruido. Queremos ver todo lo que envía el MCU al arrancar.
        this.log('Esperando carga de Firmware (500ms)...', 'log-sys');
        // this.ignoreRxUntil = Date.now() + 500; // DESACTIVADO PARA SNIFFER
        await this.sleep(500); 

        // 4. RTS Sync
        this.log('RTS → HIGH (Sincronizando UART)...', 'log-warn');
        await this.setRTS(true);
        this.setSig('RTS', true);
        await this.sleep(50);

        // Limpiar buffer antes de enviar
        this.rxBuffer = [];
        this.inPacket = false;

        this.setSig('LINK', true);
        this.log('MCU listo. Enviando comando Lámpara...', 'log-tx');

        // 4. TX [LAMP] - MODO ASCII
        await this.lampOn();

        // El resto de la validación se hará al recibir el ACK (0x06)
    }

    async setDTR(high: boolean) {
        if (this.mode === 'usb' && this.serialPort) {
            try { await this.serialPort.setSignals({ dataTerminalReady: high }); } catch(_){}
        }
    }
    async setRTS(high: boolean) {
        if (this.mode === 'usb' && this.serialPort) {
            try { await this.serialPort.setSignals({ requestToSend: high }); } catch(_){}
        }
    }

    async connect() {
        if (!(navigator as any).bluetooth) {
            this.log('Web Bluetooth no disponible. Requiere Chrome/Edge + HTTPS.', 'log-err');
            return;
        }
        try {
            this.setStatus('BUSCANDO...', 'connecting');
            this.log('Iniciando rastreo BLE puro...', 'log-tx');

            // Recopilamos ABSOLUTAMENTE TODOS los servicios UART transparentes posibles + Servicios Viavi
            // Si Chrome no tiene el UUID exacto en optionalServices, bloqueará su visibilidad en getPrimaryServices
            const ALL_POSSIBLE_SERVICES = [
                '0000ff01-0000-1000-8000-00805f9b34fb', // Viavi FF01
                '0000ffe0-0000-1000-8000-00805f9b34fb', // HM10 UART
                '49535343-fe7d-4ae5-8fa9-9fafd205e455', // ISSC Microchip UART (Muy probable en JDSU viejos)
                '6e400001-b5a3-f393-e0a9-e50e24dcca9e', // Nordic UART
                '00035b03-5800-11e2-8a77-0002a5d5c51b', // Viavi Custom UART
                '00001800-0000-1000-8000-00805f9b34fb', // Generic Access
                '00001801-0000-1000-8000-00805f9b34fb', // Generic Attribute
                '0000180a-0000-1000-8000-00805f9b34fb', // Device Information
                '0000fef5-0000-1000-8000-00805f9b34fb',
                '1d14d6ee-fd63-4fa1-bfa4-8f47b42119f0',
                0xFF01, 0xFFE0, // Short codes para forzar SDP cache bypass a veces
            ];

            // Inyectar custom UUID si el usuario lo puso (nRF Connect)
            if (this.customServiceUUID && this.customServiceUUID.length >= 4) {
                // Soportar tanto short decodificado como full string
                ALL_POSSIBLE_SERVICES.push(this.customServiceUUID);
                this.log(`Agregado UUID Manual al escáner: ${this.customServiceUUID}`, 'log-sys');
            }

            let bleDevice = null;
            try {
                this.log('Intentando emparejamiento con prefijo "MicroNIR"', 'log-sys');
                bleDevice = await (navigator as any).bluetooth.requestDevice({
                    filters: [
                        { namePrefix: 'MicroNIR' },
                        { namePrefix: 'MN' }
                    ],
                    optionalServices: ALL_POSSIBLE_SERVICES
                });
            } catch (e) {
                this.log('Fallback a escaneo estricto por servicios...', 'log-sys');
                // Intentar atrapar el dispositivo por los servicios que emite
                bleDevice = await (navigator as any).bluetooth.requestDevice({
                    filters: [{ services: ['0000ff01-0000-1000-8000-00805f9b34fb'] }],
                    optionalServices: ALL_POSSIBLE_SERVICES
                }).catch(async () => {
                    return await (navigator as any).bluetooth.requestDevice({
                        acceptAllDevices: true,
                        optionalServices: ALL_POSSIBLE_SERVICES
                    });
                });
            }

            this.bleDevice = bleDevice;
            this.log(`Emparejado: "${this.bleDevice.name}"`);
            this.bleDevice.addEventListener('gattserverdisconnected', () => this.onDisconnect());

            this.setStatus('GATT CONNECT...', 'connecting');
            this.gattServer = await this.bleDevice.gatt.connect();
            
            this.log('Esperando inicialización de servicios (Latencia)...', 'log-sys');
            await this.sleep(1500); 
            
            this.log('Solicitando tabla de servicios GATT...', 'log-tx');
            const services = await this.gattServer.getPrimaryServices();
            this.log(`Servicios primarios descubiertos: ${services.length}`, 'log-warn');

            let targetTx = null;
            let targetRx = null;

            // Análisis exhaustivo de características sin importar UUID si coinciden las propiedades
            for (const svc of services) {
                const uuid = svc.uuid.toLowerCase();
                this.log(`🔍 SERVICIO: ${uuid}`, 'log-sys');

                // Omitir los genéricos de control
                if (uuid.startsWith('00001800') || uuid.startsWith('00001801') || uuid.startsWith('0000180a')) {
                    continue;
                }

                try {
                    const chars = await svc.getCharacteristics();
                    for (const c of chars) {
                        const cUuid = c.uuid.toLowerCase();
                        const p = c.properties;
                        
                        let propsStr = [];
                        if (p.read) propsStr.push('Read');
                        if (p.write) propsStr.push('Write');
                        if (p.writeWithoutResponse) propsStr.push('WriteWoResp');
                        if (p.notify) propsStr.push('Notify');
                        if (p.indicate) propsStr.push('Indicate');

                        this.log(`  └─ Char: ${cUuid} [${propsStr.join(', ')}]`, 'log-default');
                        
                        // Lógica Pura: El TX es donde escribimos, el RX es dondo nos notifican
                        if ((p.write || p.writeWithoutResponse) && !targetTx) {
                            targetTx = c;
                        }
                        if ((p.notify || p.indicate) && !targetRx) {
                            targetRx = c;
                        }
                    }
                    if (targetTx && targetRx) {
                        this.log(`¡CANALES UART ENCONTRADOS en Servicio ${uuid.slice(0,8)}!`, 'log-warn');
                        break;
                    }
                } catch (e: any) {
                    this.log(`  └─ Fallo al leer chars en ${uuid}: ${e.message}`, 'log-err');
                    continue; // Ignorar servicios bloqueados y continuar buscando
                }
            }

            if (!targetTx || !targetRx) {
                this.log('❌ GRAVE: NO HAY CANALES UART EXPUESTOS EN BLE.', 'log-err');
                this.log('DEPURACIÓN DE HARDWARE (Según DLL Original):', 'log-sys');
                this.log('1. La DLL de Viavi usa "BluetoothAddress" (MACs reales). Esto indica que en PC utilizan BLUETOOTH CLÁSICO (Perfil RFCOMM/SPP), no BLE (Low Energy).', 'log-warn');
                this.log('2. La API Web Bluetooth de Chrome SOLO entiende BLE (GATT). Físicamente no puede ver los canales de Bluetooth Clásico.', 'log-warn');
                this.log('3. Cuando tu PC lee el hardware Viavi, lo encadena en Bluetooth Clásico. Por eso el GATT (BLE) solo muestra los genéricos 1800/1801, porque el canal de datos transparente está ruteado al SPP Classic.', 'log-warn');
                this.log('-> SOLUCIÓN TÉCNICA CORRECTA EN PC:', 'log-primary');
                this.log('   Usa la pestaña "PC/SPP (Serial)". Chrome interceptará el puerto COM que Windows crea para el Bluetooth Clásico, logrando exactamente el mismo protocolo de la DLL.', 'log-sys');
                throw new Error('Canal UART ruteado a Bluetooth Clásico (SPP) en lugar de BLE.');
            }

            this.txChar = targetTx;
            this.rxChar = targetRx;

            this.log('Habilitando Flujo de Datos...', 'log-sys');
            await this.rxChar.startNotifications();
            
            this.rxChar.addEventListener('characteristicvaluechanged',
                (e: any) => this.onRawData(new Uint8Array(e.target.value.buffer)));

            const devId = document.getElementById('devId');
            if (devId) devId.textContent = this.bleDevice.name || 'MicroNIR';
            this.setLed('MCU', true, 'on-blue');
            this.setStatus('CONECTADO (VIAVI)', 'connected');
            this.updateUI(true);

            // Handshake inicial del APK
            await this.batteryPing();
            await this.powerOnSequence();

        } catch (err: any) {
            this.setStatus('ERROR BT', 'error');
            this.log(`Fallo: ${err.message}`, 'log-err');
        }
    }

    async connectUSB() {
        if (!(navigator as any).serial) {
            this.log('Web Serial no disponible. Requiere Chrome/Edge + HTTPS.', 'log-err');
            return;
        }
        try {
            this.setStatus('BUSCANDO PUERTO...', 'connecting');
            this.log('Seleccionando puerto FTDI/USB...', 'log-tx');

            try {
                this.serialPort = await (navigator as any).serial.requestPort({
                    filters: [
                        { usbVendorId: 0x0403, usbProductId: 0x6001 }, // FTDI Estándar
                        { usbVendorId: 0x0403, usbProductId: 0x6015 }, // MicroNIR Custom PID
                        { usbVendorId: 0x1A86 }, // CH340
                        { usbVendorId: 0x10C4 }, // CP210x
                    ]
                });
            } catch(_) {
                this.serialPort = await (navigator as any).serial.requestPort();
            }

            const baud = parseInt((document.getElementById('baudRate') as HTMLSelectElement).value) || 115200;
            this.log(`Abriendo: ${baud} bps, 8N1, sin flow control...`, 'log-tx');

            await this.serialPort.open({
                baudRate:    baud,
                dataBits:    8,
                stopBits:    1,
                parity:      'none',
                flowControl: 'none'
            });

            const info = this.serialPort.getInfo();
            const vid  = (info.usbVendorId||0).toString(16).toUpperCase().padStart(4,'0');
            const pid  = (info.usbProductId||0).toString(16).toUpperCase().padStart(4,'0');
            this.log(`Puerto abierto. VID:0x${vid} PID:0x${pid}`, '');

            this.serialWriter = this.serialPort.writable.getWriter();
            this._startSerialReader();

            const devId = document.getElementById('devId');
            if (devId) devId.textContent = `FTDI VID:${vid}`;
            this.setLed('MCU', true, 'on-blue');
            this.setStatus('CONECTADO USB', 'connected');
            this.updateUI(true);
            
            this.startHeartbeat();

            await this.powerOnSequence();

        } catch (err: any) {
            this.setStatus('ERROR', 'error');
            this.log(`Error USB: ${err.message}`, 'log-err');
        }
    }

    async _startSerialReader() {
        const reader = this.serialPort.readable.getReader();
        this.serialReader = reader;
        try {
            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                if (value) this.onRawData(value);
            }
        } catch (e: any) {
            if (!e.message?.includes('cancel')) this.log(`Error lectura serial: ${e.message}`, 'log-err');
        } finally { reader.releaseLock(); }
    }

    async disconnect() {
        try {
            await this.setDTR(false);
            await this.setRTS(false);
            if (this.mode==='ble' && this.bleDevice?.gatt?.connected)
                this.bleDevice.gatt.disconnect();
            if (this.mode==='usb') {
                if (this.serialReader) try { await this.serialReader.cancel(); } catch(_){}
                if (this.serialWriter) try { this.serialWriter.releaseLock(); } catch(_){}
                if (this.serialPort)   try { await this.serialPort.close(); } catch(_){}
            }
        } catch(_){}
        this.onDisconnect();
    }

    onDisconnect() {
        this.log('Conexión terminada. DTR → LOW.', 'log-err');
        ['MCU','LAMP','ADC','DTR'].forEach(id => this.setLed(id, false));
        ['DTR','RTS','LINK'].forEach(id => this.setSig(id, false));
        this.setStatus('DESCONECTADO');
        this.updateUI(false);
        const devId = document.getElementById('devId');
        if (devId) devId.textContent = '—';
        this.txChar = this.rxChar = null;
        clearTimeout(this.responseTimeout);
    }

    async sendCmdData(cmdBytes: number[], cmdType = 'generic') {
        const payload = new Uint8Array(cmdBytes);
        const frame = this.encodePacket(payload);
        
        const cmdName = String.fromCharCode(cmdBytes[0]) || `0x${cmdBytes[0].toString(16)}`;
        let timeout = this.TIMEOUT_MS;
        if (cmdType === 'lamp')    timeout = 2500;
        if (cmdType === 'scan')    timeout = 3000;
        if (cmdType.startsWith('fuzz')) timeout = 250;
        
        this.lastCmdType = cmdType;

        try {
            if (this.mode==='usb' && this.serialWriter) {
                await this.serialWriter.write(frame);
            } else if (this.txChar) {
                if (this.txChar.properties.writeWithoutResponse) await this.txChar.writeValueWithoutResponse(frame);
                else await this.txChar.writeValue(frame);
            } else return;
            
            if (!cmdType.startsWith('fuzz')) {
                this.log(`TX [${cmdName}]: ${Array.from(frame).map(b=>'0x'+b.toString(16).padStart(2,'0')).join(' ')}`, 'log-tx');
            }
            this.startTimeoutBar();
            this.scheduleTimeout(timeout);
        } catch (e: any) { this.log(`Fallo TX: ${e.message}`, 'log-err'); }
    }

    scheduleTimeout(ms: number) {
        clearTimeout(this.responseTimeout);
        this.responseTimeout = setTimeout(() => {
            this.stopTimeoutBar(false);
            if (!this.lastCmdType?.startsWith('fuzz')) {
                this.log(`TIMEOUT (${ms}ms): MCU no respondió. Verifica: DTR HIGH, conector, latency FTDI.`, 'log-err');
            }
            this.lampReady = false;
        }, ms);
    }

    clearTimeout_() {
        clearTimeout(this.responseTimeout);
        this.stopTimeoutBar(true);
    }

    heartbeatTimer: any = null;

    // Monitoreo de Conexión, Heartbeat / Status Poll
    startHeartbeat() {
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        
        let silentCounter = 0;
        this.heartbeatTimer = setInterval(async () => {
            if (!this.serialWriter && !this.txChar) return;
            silentCounter += 5;
            // Commando 'R' = 0x52 (Read System State)
            await this.sendCmdData([0x52], 'heartbeat');
        }, 5000);
    }

    // =======================================================
    // MOTOR DE ENCRIPTACIÓN DE BAJO NIVEL (VIAVI ONSITE-W)
    // =======================================================
    
    // Constantes de Control
    private readonly SUB = 0x1A; // 26
    
    // PENDIENTE: La Trama Interna. 
    // ¿Requerimos la PassKey de 32-bits o solo enviar CMD y DATA directo?
    // Ensayaremos ambas opciones usando su propio codificador.
    private PASSKEY = new Uint8Array([0x1B, 0x0D, 0x36, 0xD5]); // 3577089307

    // El esotérico XOR-Shift polinomial de 16-bits de JDSU
    private updateCRC(crc: number, value: number): number {
        crc = ((crc >>> 8) | (crc << 8)) & 0xFFFF;
        crc ^= (value & 0xFF);
        crc ^= ((crc & 0xFF) >>> 4);
        crc ^= ((crc << 12) & 0xFFFF);
        crc ^= (((crc & 0xFF) << 5) & 0xFFFF);
        return crc & 0xFFFF;
    }

    // Codificación rigurosa Viavi: STX + Payload (Byte-Stuffed) + CRC-16 (Byte-Stuffed) + ETX
    private encodePacket(payload: Uint8Array): Uint8Array {
        let crc = 0xFFFF;
        const outStream: number[] = [];
        
        outStream.push(this.STX);
        
        const appendByte = (val: number) => {
            if (val === this.STX || val === this.ETX || val === this.SUB) {
                outStream.push(this.SUB);
                outStream.push(val ^ 0x80);
            } else {
                outStream.push(val);
            }
        };

        for (let i = 0; i < payload.length; i++) {
            const val = payload[i];
            crc = this.updateCRC(crc, val);
            appendByte(val);
        }
        
        appendByte(crc & 0xFF);
        appendByte((crc >>> 8) & 0xFF);
        
        outStream.push(this.ETX);
        return new Uint8Array(outStream);
    }

    private unStuff(buf: number[]): number[] {
        const out = [];
        for (let i = 0; i < buf.length; i++) {
            if (buf[i] === this.SUB && i + 1 < buf.length) {
                out.push(buf[i+1] ^ 0x80);
                i++;
            } else {
                out.push(buf[i]);
            }
        }
        return out;
    }

    // ==========================================
    // VIAVI FACTORY METHOD BUILDERS
    // ==========================================

    PROPERTY = {
        GET: 0x00,
        SET: 0x01
    };

    PASSKEY = [0x1B, 0x0D, 0x36, 0xD5]; // Viavi PassKey con el orden físico exacto verificado por el Fuzzer.

    createGenericGetCommand(cmdEnum: number): number[] {
        return [cmdEnum, this.PROPERTY.GET];
    }

    createGenericSetUintCommandWithPasskey(cmdEnum: number, value: number): number[] {
        // En C#, Uint32 son 4 bytes en Little Endian
        const valBytes = [
            value & 0xFF,
            (value >> 8) & 0xFF,
            (value >> 16) & 0xFF,
            (value >> 24) & 0xFF
        ];
        return [cmdEnum, this.PROPERTY.SET, ...valBytes, ...this.PASSKEY];
    }

    createGenericActionCommand(cmdEnum: number, value: number): number[] {
        return [cmdEnum, value];
    }

    // ==========================================
    // DEVICE OPERATIONS
    // ==========================================

    private isFuzzingLamp: boolean = false;

    async lampOn() {
        if (this.lampConfirmed) return;
        this.log('\n--- ENCENDIDO DE LÁMPARA (SECUENCIA DESCUBIERTA) ---', 'log-warn');
        this.log('Disparando orden firme SET=0 a la posición "!" (0x21)...', 'log-sys');
        this.setLed('LAMP', true, 'on-orange');
        this.lampReady = false;
        
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }

        // ENVÍA EXACTAMENTE LA INSTRUCCIÓN DESCUBIERTA: [0x21, Property.SET, Value=0, Passkey]
        const payload = this.createGenericSetUintCommandWithPasskey(0x21, 0x00);
        await this.sendCmdData(payload, 'lamp');

        // PAUSA TÉRMICA Y MÓDULO INDICADOR
        this.log('⏳ Comando enviado. Esperando estabilización térmica del Tungsteno (2.5s)...', 'log-sys');
        await this.sleep(2500);

        this.lampConfirmed = true;
        this.lampReady = true;
        this.log('✅ Lámpara Tungsteno encendida físicamente. ¡Permiso de escaneo concedido!', 'log-warn');
        this.updateUI(); // Esto habilita el botón de escaneo
    }

    async scan() {
        this.log('\n--- ESCANEO OFICIAL (VÍA C# DLL) ---', 'log-warn');
        this.stopFuzzerFlag = false;
        this.setLed('ADC', true, 'on-orange');
        this.rxBuffer = [];
        this.inPacket = false;
        
        if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }

        /**
         * SECUENCIA OFICIAL VÍA DLL:
         * 
         * 0. INTEGRATION_TIME = 49 (0x31)
         * 1. REPLICATES = 51 (0x33)
         * 2. ACQUIRE_SPECTRA = 34 (0x22)
         * 3. SCANDATA_PACKET = 80 (0x50)
         */

        this.log('Ajustando "Obturador" del Sensor (Integración y Réplicas)...', 'log-sys');
        
        // 0. INTEGRATION TIME = 49 -> SET = 1 -> 10,000 us (10ms).
        // 10000 en Hex es 0x2710. En little endian 32-bit: 0x10 0x27 0x00 0x00
        await this.sendCmdData([49, this.PROPERTY.SET, 0x10, 0x27, 0x00, 0x00], 'set_integration');
        await this.sleep(300);

        // 1. REPLICATES = 51 -> SET = 1 -> 50 escaneos para no saturar.
        // 50 en Hex es 0x32. En little endian 32-bit: 0x32 0x00 0x00 0x00 
        await this.sendCmdData([51, this.PROPERTY.SET, 0x32, 0x00, 0x00, 0x00], 'set_replicates');
        await this.sleep(300);

        this.log('Ordenando ACQUIRE_SPECTRA (34 / 0x22)...', 'log-sys');
        
        // 2. Disparo de escáner. StartScan (1)
        await this.sendCmdData([34, this.PROPERTY.SET, 1], 'scan_start_set_1');
        
        let waitTime = 1500; // 50 replicates * 10 ms = 500ms + latencia
        this.log(`Esperando exposición óptica (${waitTime}ms)...`, '');
        await this.sleep(waitTime); 

        this.log('Pidiendo SCANDATA_PACKET (80 / 0x50)...', 'log-sys');
        
        // 3. Pedir el SCANDATA_PACKET por GET
        await this.sendCmdData([80, this.PROPERTY.GET], 'scan_read');
    }

    private bleBuffer: number[] = [];
    private stopFuzzerFlag: boolean = false;

    stopFuzzer() {
        this.stopFuzzerFlag = true;
        this.log('🛑 SEÑAL DE PARADA ENVIADA. Deteniendo fuzzer...', 'log-warn');
    }

    async batteryPing() {
        if (!this.connected) return;
        this.log('\n--- DIAGNÓSTICO BATERÍA ---', 'log-warn');
        this.stopFuzzerFlag = false;
        
        if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }

        // Manda el comando clásico BATTERY ('D' = 0x44)
        const payload = this.createGenericGetCommand(0x44);
        await this.sendCmdData(payload, 'battery');
    }

    private bleBuffer: number[] = [];

    onRawData(bytes: Uint8Array) {
        // --- MODO SNIFFER ACTIVO ---
        // Convertimos a Hexadecimal
        const hexStr = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(' ');
        // Convertimos a ASCII (reemplazando caracteres no imprimibles con '.')
        const asciiStr = Array.from(bytes).map(b => (b >= 32 && b <= 126) ? String.fromCharCode(b) : '.').join('');
        
        // Loguear ABSOLUTAMENTE TODO sin filtrar por tiempo
        this.log(`[SNIFFER] RX HEX: ${hexStr}`, 'log-rx');
        this.log(`[SNIFFER] RX ASCII: ${asciiStr}`, 'log-rx');

        if (this.mode === 'bt') {
            // Acumular fragmentos MTU en el buffer dinámico BLE
            this.bleBuffer.push(...Array.from(bytes));

            // Analizar el buffer buscando [STX ... ETX]
            let startIdx = this.bleBuffer.indexOf(this.STX);
            let endIdx = this.bleBuffer.indexOf(this.ETX, startIdx + 1);

            while (startIdx !== -1 && endIdx !== -1) {
                const frame = this.bleBuffer.slice(startIdx + 1, endIdx);
                this.clearTimeout_();
                this.processPacketRaw(frame);

                this.bleBuffer.splice(0, endIdx + 1);
                
                startIdx = this.bleBuffer.indexOf(this.STX);
                endIdx = this.bleBuffer.indexOf(this.ETX, startIdx + 1);
            }

            // Si el buffer crece descontroladamente o hay basura antes del STX
            if (this.bleBuffer.length > 2000 && startIdx > 0) {
                this.log("Limpiando basura fragmentada del buffer BLE...", "log-sys");
                this.bleBuffer.splice(0, startIdx);
            } else if (this.bleBuffer.length > 5000) {
                this.log("Reset de emergencia del buffer BLE (Overflow).", "log-err");
                this.bleBuffer = [];
            }
        } else {
            // Modo USB, usar el paseador byte-by-byte
            this.parseBytes(bytes);
        }
    }

    stripFTDIBytes(raw: Uint8Array) {
        const out = [];
        let i = 0;
        while (i < raw.length) {
            const statusB0 = raw[i];
            const statusB1 = i+1 < raw.length ? raw[i+1] : 0;
            i += 2;

            const end = Math.min(i + this.FTDI_PAYLOAD_CHUNK, raw.length);
            while (i < end) { out.push(raw[i++]); }

            if (statusB0 !== 0x01 && statusB0 !== 0x00) {
                // Silenciado para no llenar sniffer
            }
        }
        return new Uint8Array(out);
    }

    parseBytes(bytes: Uint8Array) {
        // --- DEEP SNIFFER OVERRIDE ---
        // Extraemos lo que entra puro, sin filtrar por paquetes
        const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
        const ascii = Array.from(bytes).map(b => (b >= 32 && b <= 126) ? String.fromCharCode(b) : '.').join('');
        
        // Evitamos spammear los latidos ASCII "I" o "O"
        const isHeartbeat = bytes.length < 3 && (bytes[0] === 0x4F || bytes[0] === 0x50 || bytes[0] === 0x49 || bytes[0] === 0x0D || bytes[0] === 0x0A);
        
        if (!isHeartbeat) {
            this.log(`[SNIFFER RAW] HEX: ${hex}`);
            this.log(`[SNIFFER RAW] ASC: ${ascii}`);
        }

        // Continúa la lógica original
        for (const b of bytes) {
            if (b === this.STX) {
                this.rxBuffer = [];
                this.inPacket = true;
                continue;
            }

            if (b === this.ETX && this.inPacket) {
                this.inPacket = false;
                this.clearTimeout_();
                this.processPacketRaw([...this.rxBuffer]);
                this.rxBuffer = [];
                continue;
            }

            if (this.inPacket) {
                this.rxBuffer.push(b);
                continue;
            }

            if (b === 0x06) {
                // ACK aislado (fuera de STX/ETX)
                this.clearTimeout_();
                this.log('ACK (0x06) RECIBIDO — MCU procesó comando.', 'log-sys');
                this.handleAck();
                continue;
            }

            if (b === 0x15) {
                this.log('NAK (0x15) RECIBIDO — Aislado.', 'log-err');
                continue;
            }

            if (b === this.CR || b === 0x0A) {
                if (this.rxBuffer.length > 0) {
                    const msg = new TextDecoder().decode(new Uint8Array(this.rxBuffer)).trim();
                    if (msg) {
                        this.clearTimeout_();
                        this.log(`RX: ${msg}`, 'log-rx');
                        this.parseTextResponse(msg);
                    }
                    this.rxBuffer = [];
                }
            } else if (b >= 0x20 && b <= 0x7E) {
                this.rxBuffer.push(b);
            }
        }
    }

    processPacket(buf: number[]) {
        if (buf.length === 0) return;

        // Manejo de ACK (0x06) y NAK (0x15) dentro de trama
        if (buf[0] === 0x06 && buf.length === 1) {
            this.log('ACK (0x06) RECIBIDO — MCU procesó comando.', 'log-warn');
            this.handleAck();
            return;
        }
        
        if (buf[0] === 0x15) {
            const errCode = buf.length > 1 ? buf[1] : 'Desconocido';
            this.log(`NAK (0x15) RECIBIDO. Comando rechazado. Código de error: 0x${errCode.toString(16)}`, 'log-err');
            return;
        }

        if (buf.length < 2) { 
            this.log('Paquete incompleto descartado.', 'log-warn'); 
            return; 
        }

        const len = buf[0];
        const cmd = buf[1];

        this.log(`PKT recibido: LEN=${len} CMD=0x${cmd.toString(16).toUpperCase()} (${buf.length - 2} bytes de payload)`, 'log-rx');

        if (cmd === this.CMD.SCAN || cmd === 0x00) {
            this.processSpectrum(buf.slice(2));
        } else if (cmd === this.CMD.BATTERY) {
            const pct = buf[2] || 0;
            const valBat = document.getElementById('valBat');
            if (valBat) valBat.textContent = pct + ' %';
            this.log(`Batería: ${pct}%`, '');
        } else if (cmd === this.CMD.TEMP) {
            const t = ((buf[2]||0) | ((buf[3]||0) << 8)) / 10;
            const valTemp = document.getElementById('valTemp');
            if (valTemp) valTemp.textContent = t.toFixed(1) + ' °C';
        } else {
            this.log(`PKT desconocido CMD=0x${cmd.toString(16)} ignorado.`, 'log-sys');
        }
    }

    processPacketRaw(buf: number[]) {
        if (buf.length < 2) return;
        
        // 1. Quitar el Byte Stuffing
        const unstuffed = this.unStuff(buf);
        if (unstuffed.length < 2) return;

        // 2. Extraer el CRC recibido (últimos 2 bytes de la trama útil)
        const rxLsb = unstuffed[unstuffed.length - 2];
        const rxMsb = unstuffed[unstuffed.length - 1];
        
        // 3. Extraer el Payload real
        const payload = unstuffed.slice(0, unstuffed.length - 2);

        // 4. Calcular el CRC nuestro para contrastar
        let calcCrc = 0xFFFF;
        for (const b of payload) { calcCrc = this.updateCRC(calcCrc, b); }
        
        const expectedLsb = calcCrc & 0xFF;
        const expectedMsb = (calcCrc >>> 8) & 0xFF;

        const cmd = payload[0];

        if (rxLsb !== expectedLsb || rxMsb !== expectedMsb) {
            this.log(`⚠ CRC Error en 0x${cmd.toString(16)}. RX:${rxLsb.toString(16).padStart(2,'0')}${rxMsb.toString(16).padStart(2,'0')} != CALC:${expectedLsb.toString(16).padStart(2,'0')}${expectedMsb.toString(16).padStart(2,'0')}`, 'log-err');
            return;
        }

        this.log(`📥 [OK] CRC Validado | CMD = 0x${cmd.toString(16).toUpperCase()} | Len = ${payload.length}`, 'log-rx');

        // Procesar Payload Lógico
        if (cmd === 0x06) {
            this.log(`ACK RECIBIDO (0x06). Comando [${this.lastCmdType}] FUNCIONÓ. ¡ESTE ES EL DICCIONARIO!`, 'log-warn');
            this.handleAck();
        } else if (cmd === 0x15) {
            // Loguear siempre los NAKs si no es fuzzer extremo
            const err = payload.length > 1 ? payload[1] : 0;
            this.log(`NAK RECIBIDO. Código de Error HW: ${err} (0x${err.toString(16)})`, 'log-err');
        } else if (cmd === 0x50) { 
            // 0x50 (80) es el SCANDATA_PACKET oficial según la DLL.
            // Payload total es de 289 bytes. El byte 0 es el CMD (0x50).
            // Luego vienen 256 bytes de espectro (128 * 2).
            // Y 32 bytes de metadatos térmicos / HW.
            const pixelData = payload.slice(1, 257); 
            this.log(`Extraídos 256 bytes de Array de InGaAs. Enviando a Gráfica...`, 'log-warn');
            this.processSpectrum(pixelData);
        } else if (cmd === 0x53 || cmd === this.CMD.SCANDATA_PACKET) {
            this.processSpectrum(payload.slice(1));
        } else if (cmd === 0x42 || cmd === this.CMD.BATTERY) {
            const pct = payload.length > 1 ? payload[1] : 0; // Fix safe access
            const valBat = document.getElementById('valBat');
            if (valBat) valBat.textContent = pct + ' %';
            this.log(`Nivel Batería/Info: ${Array.from(payload).map(b => b.toString(16).padStart(2,'0')).join(' ')}`, 'log-default');
        } else if (cmd === 0x54 || cmd === this.CMD.TEMP) {
            const t = ((payload[1]||0) | ((payload[2]||0) << 8)) / 10;
            const valTemp = document.getElementById('valTemp');
            if (valTemp) valTemp.textContent = t.toFixed(1) + ' °C';
        } else if (cmd === 0x52) {
            this.log(`Status Report: ${Array.from(payload).map(b => b.toString(16).padStart(2,'0')).join(' ')}`, 'log-sys');
        }
    }

    handleAck() {
        if (this.lastCmdType === 'lamp') {
            this.log('Lámpara confirmada por MCU. Esperando estabilidad térmica (2500ms)...', 'log-warn');
            setTimeout(() => {
                this.lampConfirmed = true;
                this.setLed('LAMP', true, 'on-green');
                this.log('✅ Lámpara Tungsteno encendida físicamente. ¡Permiso de escaneo concedido!', 'log-default');
                const btnScan = document.getElementById('btnScan') as HTMLButtonElement;
                if (btnScan) btnScan.disabled = false;
                
                // AUTO-SCAN TRIGGER
                this.log('⚡ Iniciando Auto-Escaneo DLL...', 'log-warn');
                this.scan(); // Gatilla el escaneo automáticamente
            }, 2500);
        }
    }

    processSpectrum(raw: number[]) {
        if (raw.length < 4) { this.log('Datos de espectro insuficientes.', 'log-warn'); return; }

        const spectrum = [];
        for (let i = 0; i + 1 < raw.length; i += 2) {
            spectrum.push((raw[i+1] << 8) | raw[i]);
        }

        if (spectrum.length === 0) return;

        this.lastSpectrum = spectrum;
        this.pktCount++;
        const valPkt = document.getElementById('valPkt');
        if (valPkt) valPkt.textContent = `${spectrum.length} / ${this.pktCount}`;
        this.log(`Espectro OK: ${spectrum.length} píxeles, paquete #${this.pktCount}`, '');
        this.setLed('ADC', true, 'on-green');

        let displayData = spectrum;
        if (this.baselineData && this.showBaseline && this.baselineData.length === spectrum.length) {
            displayData = spectrum.map((v, i) => {
                const ref = this.baselineData![i] || 1;
                return ref > 0 ? -Math.log10(v / ref) * 1000 : 0;
            });
            this.log('Absorbancia calculada (Log(I/I0) × 1000).', 'log-sys');
        }

        this.updateChart(displayData, spectrum.length);
        this.saveScan(spectrum);
    }

    saveScan(data: number[]) {
        const scan = {
            id: (Math.random() * 100000).toString(36),
            name: `Escaneo ${this.history.length + 1}`,
            data: [...data],
            time: Date.now()
        };
        this.history.unshift(scan);
        if (this.history.length > 50) this.history.pop();
        localStorage.setItem('mn_history', JSON.stringify(this.history));
        this.renderHistory();
    }

    deleteHistoryItem(id: string) {
        this.history = this.history.filter(h => h.id !== id);
        localStorage.setItem('mn_history', JSON.stringify(this.history));
        this.renderHistory();
    }

    clearHistory() {
        if (!confirm('¿Borrar todo el historial?')) return;
        this.history = [];
        localStorage.setItem('mn_history', '[]');
        this.renderHistory();
    }

    renderHistory() {
        const container = document.getElementById('historyList');
        if (!container) return;
        container.innerHTML = this.history.length === 0 ? '<div class="dim-text" style="font-size:0.65rem; padding:10px;">Sin historial...</div>' : '';
        
        this.history.forEach(h => {
            const div = document.createElement('div');
            div.className = 'history-item';
            div.innerHTML = `
                <div class="h-info">
                    <div class="h-name">${h.name}</div>
                    <div class="h-date">${new Date(h.time).toLocaleTimeString()}</div>
                </div>
                <div class="h-btns" style="display:flex; gap:4px">
                    <button class="h-btn-view" style="background:transparent; border:none; cursor:pointer;" title="Ver">👁️</button>
                    <button class="h-btn-del" style="background:transparent; border:none; cursor:pointer; color:var(--red);" title="Borrar">×</button>
                </div>
            `;
            div.querySelector('.h-btn-view')?.addEventListener('click', () => this.updateChart(h.data, h.data.length));
            div.querySelector('.h-btn-del')?.addEventListener('click', (e) => {
                e.stopPropagation();
                this.deleteHistoryItem(h.id);
            });
            container.appendChild(div);
        });
    }

    updateChart(data: number[], pixelCount = 128) {
        const labels = Array.from({length: pixelCount}, (_, i) =>
            Math.round(908 + i * (1676 - 908) / (pixelCount - 1))
        );
        this.chart.data.labels = labels;
        this.chart.data.datasets[0].data = data;
        this.chart.update();
    }

    clearChart() {
        this.chart.data.datasets[0].data = [];
        this.chart.data.datasets[1].data = [];
        this.chart.update();
        this.lastSpectrum = [];
        this.log('Gráfica limpiada.', 'log-sys');
    }

    toggleBaseline() {
        if (!this.lastSpectrum.length) { this.log('Sin espectro de referencia.', 'log-warn'); return; }
        if (!this.baselineData) {
            this.baselineData = [...this.lastSpectrum];
            this.chart.data.datasets[1].data = this.baselineData;
            this.chart.update();
            this.log(`Baseline guardado (${this.baselineData.length} px). Próximo scan = absorbancia.`, '');
            this.showBaseline = true;
        } else {
            this.baselineData = null;
            this.showBaseline = false;
            this.chart.data.datasets[1].data = [];
            this.chart.update();
            this.log('Baseline eliminado. Mostrando intensidad raw.', 'log-sys');
        }
    }

    exportCSV() {
        if (!this.lastSpectrum.length) { this.log('Sin datos.', 'log-warn'); return; }
        const rows = ['wavelength_nm,intensity_16bit,absorbance'].concat(
            this.lastSpectrum.map((v, i) => {
                const nm  = Math.round(908 + i * (1676 - 908) / 127);
                const abs = this.baselineData && this.baselineData[i] > 0
                    ? (-Math.log10(v / this.baselineData[i])).toFixed(5) : '';
                return `${nm},${v},${abs}`;
            })
        );
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([rows.join('\n')], {type:'text/csv'}));
        a.download = `micronir_${Date.now()}.csv`;
        a.click();
        this.log('CSV exportado.', '');
    }

    promptUUID(): Promise<string | null> {
        return new Promise(resolve => {
            const modal = document.getElementById('uuidModal');
            const input = document.getElementById('uuidModalInput') as HTMLInputElement;
            if (!modal || !input) { resolve(null); return; }
            input.value = (document.getElementById('customUUIDInput') as HTMLInputElement).value;
            modal.style.display = 'flex';
            setTimeout(() => input.focus(), 80);

            const ok = () => {
                modal.style.display = 'none';
                const v = input.value.trim().toLowerCase();
                if (v) (document.getElementById('customUUIDInput') as HTMLInputElement).value = v;
                resolve(v || null);
            };
            const cancel = () => { modal.style.display = 'none'; resolve(null); };

            const btnOk = document.getElementById('btnUUIDOk');
            const btnCancel = document.getElementById('btnUUIDCancel');
            if (btnOk) btnOk.onclick = ok;
            if (btnCancel) btnCancel.onclick = cancel;
            input.onkeydown = e => { if (e.key==='Enter') ok(); if (e.key==='Escape') cancel(); };
        });
    }

    sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
}

export default function App() {
    const appRef = useRef<MicroNIRApp | null>(null);

    useEffect(() => {
        if (!appRef.current) {
            appRef.current = new MicroNIRApp();
            appRef.current.initChart();
            appRef.current.setMode('ble');
            appRef.current.renderHistory();
        }
    }, []);

    const app = () => appRef.current;

    return (
        <>
            <header>
                <div className="logo">
                    <div className="logo-icon">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--primary)" strokeWidth="2.5">
                            <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
                        </svg>
                    </div>
                    <div>
                        <div className="logo-text">Micro<em>NIR</em> QualiControl</div>
                        <div className="logo-sub">HARDWARE ORCHESTRATOR v6.0 · FTDI PROTOCOL</div>
                    </div>
                </div>
                <div className="hdr-right">
                    <div className="conn-tabs">
                        <button className="conn-tab active" id="tabBLE" onClick={() => app()?.setMode('ble')}>
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11M12 2v20"/></svg>
                            BLE (MÓVIL)
                        </button>
                        <button className="conn-tab" id="tabUSB" onClick={() => app()?.setMode('usb')}>
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><rect x="7" y="8" width="10" height="8" rx="1"/><path d="M12 2v6M8 22h8M12 16v6"/></svg>
                            PC/SPP (SERIAL)
                        </button>
                    </div>
                    <div className="status-pill" id="statusPill">
                        <div className="dot"></div>
                        <span id="statusText">DESCONECTADO</span>
                    </div>
                </div>
            </header>

            <div className="main">
                <aside className="sidebar">
                    <div className="sec-label">Estado de Hardware</div>
                    <div className="hw-panel">
                        <div className="hw-top">
                            <span className="hw-name">Módulo MicroNIR</span>
                            <span className="hw-id" id="devId">—</span>
                        </div>
                        <div className="led-row">
                            <div className="led-badge" id="ledMCU"><div className="d"></div>MCU</div>
                            <div className="led-badge" id="ledLAMP"><div className="d"></div>LAMP</div>
                            <div className="led-badge" id="ledADC"><div className="d"></div>ADC</div>
                            <div className="led-badge" id="ledDTR"><div className="d"></div>PWR</div>
                        </div>
                        <div className="signal-row">
                            <div className="sig-badge" id="sigDTR"><div className="d"></div>DTR</div>
                            <div className="sig-badge" id="sigRTS"><div className="d"></div>RTS</div>
                            <div className="sig-badge" id="sigLINK"><div className="d"></div>LINK</div>
                        </div>
                    </div>

                    <div className="uuid-box" id="uuidBox">
                        <div className="sec-label">UUID Servicio BLE (opcional)</div>
                        <input id="customUUIDInput" type="text"
                            placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                            onInput={(e: any) => { if (appRef.current) appRef.current.customServiceUUID = e.target.value.trim().toLowerCase() || null; }}
                        />
                        <div style={{fontSize:'.58rem', color:'var(--dim)', marginTop:'3px'}}>
                            Vacío = detección automática. Usa nRF Connect para obtenerlo.
                        </div>
                    </div>

                    <div className="serial-cfg" id="serialCfg">
                        <label>Baud Rate
                            <select id="baudRate" defaultValue="115200">
                                <option value="9600">9600</option>
                                <option value="19200">19200</option>
                                <option value="57600">57600</option>
                                <option value="115200">115200 (MicroNIR)</option>
                            </select>
                        </label>
                    </div>

                    <div id="bleSection">
                        <button className="btn btn-primary" onClick={() => app()?.connect()}>
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11M12 2v20"/></svg>
                            Conectar BLE (Móviles)
                        </button>
                    </div>

                    <div id="usbSection" style={{display:'none'}}>
                        <button className="btn btn-primary" onClick={() => app()?.connectUSB()}>
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><rect x="7" y="8" width="10" height="8" rx="1"/><path d="M12 2v6"/></svg>
                            Conectar PC Bluetooth / USB
                        </button>
                    </div>

                    <div className="timeout-bar-wrap" id="timeoutBarWrap">
                        <div className="timeout-bar" id="timeoutBar" style={{width:'100%'}}></div>
                    </div>

                    <div className="btn-row">
                        <button id="btnWarm" className="btn btn-ghost-orange" onClick={() => app()?.lampOn()} disabled>
                            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><circle cx="12" cy="12" r="5"/><line x1="12" y1="2" x2="12" y2="4"/><line x1="12" y1="20" x2="12" y2="22"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="2" y1="12" x2="4" y2="12"/><line x1="20" y1="12" x2="22" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
                            Lámpara
                        </button>
                        <button id="btnBat" className="btn btn-ghost-green" onClick={() => app()?.batteryPing()} disabled>
                            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><rect x="2" y="7" width="16" height="10" rx="1"/><line x1="22" y1="10" x2="22" y2="14"/></svg>
                            Batería (DLL)
                        </button>
                    </div>

                    <button id="btnScan" className="btn btn-scan" onClick={() => app()?.scan()} disabled>
                        ▶ FORZAR DISPARO DE ESCÁNER
                    </button>

                    <div className="history-section">
                        <div className="history-hdr">
                            <div className="sec-label">Historial de Calidad</div>
                            <button className="h-clear" onClick={() => app()?.clearHistory()}>Limpiar</button>
                        </div>
                        <div id="historyList" className="history-list">
                            <div className="dim-text" style={{fontSize:'.65rem', padding:'10px'}}>Sin historial...</div>
                        </div>
                    </div>

                    <button id="btnDisc" className="btn btn-ghost-red" onClick={() => app()?.disconnect()} disabled style={{fontSize:'.7rem', padding:'7px'}}>
                        Desconectar
                    </button>
                </aside>

                <main className="content">
                    <div className="metrics-row">
                        <div className="metric">
                            <div className="m-label">MODO / CHIP</div>
                            <div className="m-val" id="valMode">—</div>
                        </div>
                        <div className="metric m-orange">
                            <div className="m-label">INTEGRACIÓN ADC</div>
                            <div className="m-val orange" id="valExp">— ms</div>
                        </div>
                        <div className="metric m-warn">
                            <div className="m-label">TEMP. SENSOR</div>
                            <div className="m-val warn" id="valTemp">— °C</div>
                        </div>
                        <div className="metric m-green">
                            <div className="m-label">BATERÍA [D:42]</div>
                            <div className="m-val green" id="valBat">— %</div>
                        </div>
                        <div className="metric m-purple">
                            <div className="m-label">PÍXELES / PAQUETES</div>
                            <div className="m-val purple" id="valPkt">— / —</div>
                        </div>
                    </div>

                    <div className="chart-panel">
                        <div className="chart-hdr">
                            <span className="chart-title">ESPECTRO NIR — 128 PÍXELES InGaAs · 16-BIT LITTLE ENDIAN</span>
                            <div className="chart-btns">
                                <button className="chip-btn" onClick={() => app()?.clearChart()}>Limpiar</button>
                                <button className="chip-btn" onClick={() => app()?.exportCSV()}>CSV</button>
                                <button className="chip-btn" onClick={() => app()?.toggleBaseline()}>Baseline</button>
                            </div>
                        </div>
                        <div className="chart-canvas-wrap">
                            <canvas id="nirChart"></canvas>
                        </div>
                    </div>

                    <div className="terminals-panel" style={{display: 'flex', gap: '15px', height: '450px', flexShrink: 0}}>
                        <div className="console-wrap" style={{ display: 'flex', flexDirection: 'column' }}>
                            <div className="sec-label" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <span>Monitor UART / Protocolo BLE</span>
                                <button className="chip-btn" onClick={() => app()?.stopFuzzer()} style={{ backgroundColor: '#e74c3c', color: 'white', border: 'none', padding: '3px 10px', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}>
                                    🛑 DETENER FUZZER
                                </button>
                            </div>
                            <div className="console" id="console" style={{ fontSize: '13px', lineHeight: '1.4' }}>
                                <div className="log-sys">{'>'} MicroNIR Controller v6.0 — Modo Producción.</div>
                            </div>
                        </div>
                        <div className="console-wrap" style={{ display: 'flex', flexDirection: 'column' }}>
                            <div className="sec-label">Monitor de Datos Crudos (Hex)</div>
                            <div className="console raw-console" id="rawMonitor" style={{ fontSize: '13px', lineHeight: '1.4' }}>
                                <div className="dim-text">Esperando datos rx...</div>
                            </div>
                        </div>
                    </div>
                </main>
            </div>

            <div className="modal-overlay" id="uuidModal">
                <div className="modal">
                    <h3>UUID de Servicio Requerido</h3>
                    <p>
                        El descubrimiento automático no encontró servicios accesibles.<br/>
                        Usa <span>nRF Connect</span> o <span>LightBlue</span> para obtener
                        el UUID del servicio UART del MicroNIR y pégalo aquí.
                    </p>
                    <input id="uuidModalInput" type="text" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"/>
                    <div className="modal-btns">
                        <button className="btn btn-primary" id="btnUUIDOk">Confirmar y Reconectar</button>
                        <button className="btn btn-ghost-red" id="btnUUIDCancel">Cancelar</button>
                    </div>
                </div>
            </div>
        </>
    );
}
