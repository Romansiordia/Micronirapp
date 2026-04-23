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
    CMD: { [key: string]: number };
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
    referenceData: { dark: number[] | null, white: number[] | null };
    scanCounter: number;
    showAbsorbance: boolean;
    pktCount: number;
    scansToAverage: number = 4;
    multiScanBuffer: number[][] = [];
    isAveragingInProgress: boolean = false;
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
        this.referenceData = { dark: null, white: null };
        this.scanCounter = 0;
        this.showAbsorbance = false;
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
        const labels = Array.from({length: 125}, (_, i) =>
            (908.1 + i * 6.19435).toFixed(2)
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
                        grid: { color: 'rgba(0,0,0,0.06)' },
                        ticks: { color: '#6b7d91', font: { family: 'Share Tech Mono', size: 10 } },
                        title: { display: true, text: 'ADC (16-bit BE)', color: '#6b7d91', font: { size: 10, family: 'Share Tech Mono' } }
                    },
                    x: {
                        grid: { color: 'rgba(0,0,0,0.06)' },
                        ticks: { color: '#6b7d91', font: { family: 'Share Tech Mono', size: 9 }, maxTicksLimit: 12 },
                        title: { display: true, text: 'Longitud de onda (nm)', color: '#6b7d91', font: { size: 10, family: 'Share Tech Mono' } }
                    }
                },
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        backgroundColor: '#ffffff',
                        borderColor: '#d1d9e6', borderWidth: 1,
                        titleColor: '#008fb3', bodyColor: '#2b3a4a',
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

    consolePaused = false;

    log(msg: string, type = '') {
        if (this.consolePaused && type !== 'log-sys' && type !== 'log-warn') return; // Permitir que mensajes de sistema importantes se sigan viendo 
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
        ['btnDisc'].forEach(id => {
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
        this.log('MCU listo y en modo Standby.', 'log-warn');
        this.log('Por favor inicia la calibración (OSCURIDAD -> BLANCO -> MUESTRA).', 'log-sys');
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
    
    // Trama Interna. 
    private PASSKEY_BIN = new Uint8Array([0x1B, 0x0D, 0x36, 0xD5]); // 3577089307

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

    PASSKEY = [0x1B, 0x0D, 0x36, 0xD5]; // Viavi PassKey
    HW_REPS = 50; 

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

    async batteryPing() {
        if (!this.connected) return;
        this.log('\n--- DIAGNÓSTICO BATERÍA ---', 'log-warn');
        
        if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }

        // Manda el comando clásico BATTERY ('D' = 0x44)
        const payload = this.createGenericGetCommand(0x44);
        await this.sendCmdData(payload, 'battery');
    }

    private bleBuffer: number[] = [];
    private multiPartBuffer: number[] = [];
    private waitingForMultipartCount: number = 0;
    private multipartTimeout: any = null;

    onRawData(bytes: Uint8Array) {
        // --- MODO SNIFFER ACTIVO ---
        const hexStr = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(' ');
        const asciiStr = Array.from(bytes).map(b => (b >= 32 && b <= 126) ? String.fromCharCode(b) : '.').join('');
        
        this.log(`[SNIFFER] RX HEX: ${hexStr}`, 'log-rx');
        this.log(`[SNIFFER] RX ASCII: ${asciiStr}`, 'log-rx');

        if (this.mode === 'bt') {
            // Acumular fragmentos en el buffer dinámico
            this.bleBuffer.push(...Array.from(bytes));

            // MODIFICACIÓN: Detector de Payload Gigante Multipartes
            if (this.waitingForMultipartCount === 0 && this.bleBuffer.length >= 2 && this.bleBuffer[0] === this.STX && this.bleBuffer[1] === 0x50) {
                this.waitingForMultipartCount = 289; 
                clearTimeout(this.multipartTimeout);
                this.multipartTimeout = setTimeout(() => {
                    if (this.waitingForMultipartCount > 0) {
                        this.log(`❌ TIMEOUT: El paquete gigante (0x50) no se completó. Limpiando buffer.`, 'log-err');
                        this.bleBuffer = [];
                        this.waitingForMultipartCount = 0;
                        this.scanTarget = false;
                    }
                }, 4000);
            }

            // Si estamos atrapando el paquete gigante
            if (this.waitingForMultipartCount > 0) {
                if (this.bleBuffer.length >= this.waitingForMultipartCount) {
                    clearTimeout(this.multipartTimeout);
                    const fullFrame = this.bleBuffer.slice(1, this.waitingForMultipartCount - 1); 
                    this.clearTimeout_();
                    this.processPacketRaw(fullFrame);
                    this.bleBuffer.splice(0, this.waitingForMultipartCount);
                    this.waitingForMultipartCount = 0;
                } else {
                    return; 
                }
            }

            // Flujo Normal (Paquetes cortos con STX y ETX)
            if (this.waitingForMultipartCount === 0) {
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

                if (this.bleBuffer.length > 2000 && startIdx > 0) {
                    this.log("Limpiando basura fragmentada...", "log-sys");
                    this.bleBuffer.splice(0, startIdx);
                } else if (this.bleBuffer.length > 5000) {
                    this.bleBuffer = [];
                }
            }
        } else {
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
                        this.log(`RX Texto: ${msg}`, 'log-rx');
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

        // Validar si es un NAK (0x15) con payload de 1 o 2 bytes
        if (cmd === 0x15) {
            const err = payload.length > 1 ? payload[1] : unstuffed[1]; 
            this.log(`NAK RECIBIDO. Código de Error HW: ${err} (0x${err.toString(16)})`, 'log-err');
            return;
        }

        if (rxLsb !== expectedLsb || rxMsb !== expectedMsb) {
            if (cmd !== 0x15) { // Los NAK a veces tienen CRC corto
                this.log(`⚠ CRC Error en 0x${cmd.toString(16)}. RX:${rxLsb.toString(16).padStart(2,'0')}${rxMsb.toString(16).padStart(2,'0')} != CALC:${expectedLsb.toString(16).padStart(2,'0')}${expectedMsb.toString(16).padStart(2,'0')}`, 'log-err');
                return;
            }
        }

        this.log(`📥 [OK] CRC Validado | CMD = 0x${cmd.toString(16).toUpperCase()} | Len = ${payload.length}`, 'log-rx');

        // Procesar Payload Lógico
        if (cmd === 0x06) {
            this.log(`ACK RECIBIDO (0x06). Comando [${this.lastCmdType}] FUNCIONÓ. ¡ESTE ES EL DICCIONARIO!`, 'log-warn');
            this.handleAck();
        } else if (cmd === 0x15) {
            const err = payload.length > 1 ? payload[1] : 0;
            this.log(`NAK RECIBIDO. Código de Error HW: ${err} (0x${err.toString(16)})`, 'log-err');
        } else if (cmd === 0x50) { 
            // 0x50 (80) es el SCANDATA_PACKET oficial según la DLL.
            // Payload total es de 289 bytes. El byte 0 es el CMD (0x50).
            const pixelData = payload.slice(1, 257); 
            this.log(`Extraídos 256 bytes de Array de InGaAs (Offset 1). Enviando a Gráfica...`, 'log-warn');
            this.processSpectrum(pixelData);

            // EXTRACCIÓN DE TELEMETRÍA (Metadata bytes 257-288)
            if (payload.length >= 288) {
                // 1. Integración ADC (Microsegundos en Offset 272-273)
                // Log: ... 27 10 ... -> 0x2710 = 10000 -> 12.5ms según CSV usuario
                const iRaw = payload[272] | (payload[273] << 8);
                const valExp = document.getElementById('valExp');
                if (valExp && iRaw > 0) {
                    const expMs = (iRaw * 12.5 / 10000).toFixed(1);
                    valExp.textContent = `${expMs} ms`;
                }

                // 2. Voltaje detectado en Offset 278-279 (mV)
                const vRaw = payload[278] | (payload[279] << 8);
                const vBat = vRaw / 10; // Convertir a mV si viene en unidades de 10
                if (vBat > 500) {
                    const volts = (vBat / 1000).toFixed(2);
                    const elBat = document.getElementById('valBat');
                    if (elBat) elBat.textContent = `${volts} V`;
                }

                // 3. Temperatura detectada en Offset 274-275
                const tRaw = payload[274] | (payload[275] << 8);
                if (tRaw > 100 && tRaw < 800) {
                    const tempC = tRaw / 10;
                    const elTemp = document.getElementById('valTemp');
                    if (elTemp) elTemp.textContent = `${tempC.toFixed(1)}°C`;
                }
            }
        } else if (cmd === 0x53) {
            // Manejo flexible para comando 0x53
            if (payload.length >= 257) {
                this.processSpectrum(payload.slice(1, 257));
            } else {
                this.processSpectrum(payload.slice(1));
            }
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
            }, 2500);
        } else if (this.lastCmdType === 'lamp_off_wait') {
            this.log('✅ Lámpara Apagada. Esperando enfriamiento térmico (2500ms)...', 'log-sys');
            setTimeout(() => { 
                if (this.scanTarget === 'dark') this.takeAndSleepScan(false); 
            }, 2500); 
        } else if (this.lastCmdType === 'lamp_off_hard') {
            this.log('✅ Comando 0x4C (Hard Lamp Off) Confirmado.', 'log-sys');
            this.log('Esperando enfriamiento del filamento (2500ms)...', 'log-warn');
            setTimeout(() => { 
                if (this.scanTarget === 'dark') this.takeAndSleepScan(false); 
            }, 2500); 
        } else if (this.lastCmdType === 'lamp_off') {
            this.log('✅ Lámpara Apagada Confirmada. Esperando enfriamiento (2000ms)...', 'log-sys');
            setTimeout(() => { 
                if (this.scanTarget === 'dark') this.takeAndSleepScan(false); 
            }, 2000); 
        } else if (this.lastCmdType === 'lamp_on_continuous') {
            this.log('✅ Lámpara Encendida Confirmada. Esperando Estabilidad Térmica (1500ms)...', 'log-sys');
            setTimeout(() => { this.takeAndSleepScan(true); }, 1500); 
        } else if (this.lastCmdType === 'scan_read_wait') {
            setTimeout(() => {
                this.log('Pidiendo SCANDATA_PACKET (80 / 0x50)...', 'log-sys');
                this.sendCmdData([80, this.PROPERTY.GET], 'scan_read');
            }, 300);
        }
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

    updateChart(data: number[], pixelCount = 125) {
        // Alineación Lineal Exacta basada en el CSV oficial M1-0000343
        // Rango: 908.1nm - 1676.2nm en 125 puntos (paso de ~6.19435nm)
        const labels = Array.from({length: pixelCount}, (_, i) => {
            const nm = 908.1 + (6.19435 * i);
            return nm.toFixed(2);
        });
        this.chart.data.labels = labels;
        this.chart.data.datasets[0].data = data;

        // --- LÓGICA DE AUTO-ESCALA PARA DARK SCAN ---
        if (this.scanTarget === 'dark' && !this.showAbsorbance) {
            const min = Math.min(...data);
            const max = Math.max(...data);
            const padding = (max - min) * 0.2 || 10;
            this.chart.options.scales.y.suggestedMin = Math.floor(min - padding);
            this.chart.options.scales.y.suggestedMax = Math.ceil(max + padding);
        } else if (this.showAbsorbance) {
            this.chart.options.scales.y.suggestedMin = -0.01;
            this.chart.options.scales.y.suggestedMax = undefined;
        } else {
            this.chart.options.scales.y.suggestedMin = 0;
            this.chart.options.scales.y.suggestedMax = 65535;
        }

        this.chart.update('none');
    }

    clearChart() {
        this.chart.data.datasets[0].data = [];
        this.chart.data.datasets[1].data = [];
        this.chart.update();
        this.lastSpectrum = [];
        this.log('Gráfica limpiada.', 'log-sys');
    }

    scanTarget: 'dark' | 'white' | 'sample' | false = false;

    HW_REPS = 100; 

    async takeAndSleepScan(withLamp: boolean) {
        this.log(`\n--- ESCANEO MECÁNICO DE PRECISIÓN (${this.HW_REPS} Reps) ---`, 'log-warn');
        this.setLed('ADC', true, 'on-orange');
        this.rxBuffer = [];
        this.inPacket = false;
        
        // Configuración de 2 segundos de integración térmica
        this.log(`Configurando integración interna: ${this.HW_REPS} reps...`, 'log-sys');
        const configPayload = this.createGenericSetUintCommandWithPasskey(53, this.HW_REPS);
        await this.sendCmdData(configPayload, 'config_hw_reps');
        await this.sleep(150);

        const presetId = withLamp ? 0x01 : 0x00;
        await this.sendCmdData([34, presetId, 0x00], 'scan_start_act');
        
        const waitTime = 2000; 
        this.log(`Integrando espectro... (LED Amarillo encendido ${waitTime}ms)`, 'log-sys');
        await this.sleep(waitTime); 

        this.sendCmdData([80, this.PROPERTY.GET], 'scan_read_wait');
    }

    setDarkReference() {
        if (!this.connected) return alert("Conecta el MicroNIR primero.");
        this.log('═══ CALIBRACIÓN OSCURA (DARK SCAN) ═══', 'log-warn');
        this.rxBuffer = [];
        this.scanTarget = 'dark';
        this.showAbsorbance = false;
        this.isAveragingInProgress = false; 
        this.multiScanBuffer = [];

        this.log('Apagando lámpara (Modo 0x21)...', 'log-sys');
        this.sendCmdData([0x21, 0x00, 0x00], 'lamp_off_wait');
    }

    setWhiteReference() {
        if (!this.connected) return alert("Conecta el MicroNIR primero.");
        this.log('═══ CALIBRACIÓN BLANCA (WHITE SCAN) ═══', 'log-warn');
        this.rxBuffer = [];
        this.scanTarget = 'white';
        this.showAbsorbance = false;
        this.isAveragingInProgress = false;
        this.multiScanBuffer = [];
        
        this.log('Activando Lámpara para Referencia Blanca...', 'log-sys');
        this.sendCmdData([0x21, 0x01, 0x00], 'lamp_on_continuous');
    }

    scanSample() {
        if (!this.connected) return alert("Conecta el MicroNIR primero.");
        if (!this.referenceData.dark || !this.referenceData.white) {
             return alert("Por favor toma la Oscuridad [1] y Blanco [2] antes de escanear la muestra.");
        }
        this.log('═══ ANÁLISIS MULTI-PUNTO (4 ESCANEOS -> 1 PROMEDIO) ═══', 'log-warn');
        this.rxBuffer = [];
        this.scanTarget = 'sample';
        this.showAbsorbance = true;
        
        this.scansToAverage = 4;
        this.isAveragingInProgress = true;
        this.multiScanBuffer = [];
        
        const progContainer = document.getElementById('progressContainer');
        if (progContainer) {
            progContainer.style.display = 'block';
            this.updateProgress(0);
        }

        this.sendCmdData([0x21, 0x01, 0x00], 'lamp_on_continuous');
    }

    updateProgress(current: number) {
        const per = Math.round((current / this.scansToAverage) * 100);
        const bar = document.getElementById('progressBar');
        const txt = document.getElementById('progressText');
        if (bar) bar.style.width = `${per}%`;
        if (txt) txt.textContent = `${per}%`;
    }

    processSpectrum(raw: number[]) {
        if (!this.scanTarget) return;

        try {
            if (raw.length < 256) { 
                this.log(`Datos insuficientes para espectro (${raw.length} bytes)`, 'log-warn'); 
                return; 
            }

            let spectrum: number[] = [];
            let saturatedCount = 0;
            const maxLen = Math.min(256, raw.length);
            for (let i = 0; i < maxLen - 1; i += 2) {
                const val = ((raw[i] & 0xFF) << 8) | (raw[i+1] & 0xFF);
                if (spectrum.length < 125) {
                    spectrum.push(val);
                }
                if (val >= 65530 && i < 60) saturatedCount++; 
            }
            
            if (saturatedCount > 3) {
                this.log('⚠️ ALERTA DE SATURACIÓN!', 'log-warn');
            }
            
            if (spectrum.length === 0) return;

            // --- LÓGICA DE PROMEDIADO MULTI-PUNTO (4 Escaneos para Muestra) ---
            if (this.isAveragingInProgress && this.scanTarget === 'sample') {
                this.multiScanBuffer.push([...spectrum]);
                this.updateProgress(this.multiScanBuffer.length);
                
                if (this.multiScanBuffer.length < this.scansToAverage) {
                    this.log(`✓ Punto ${this.multiScanBuffer.length}/4 capturado. MUEVE LA MUESTRA...`, 'log-warn');
                    setTimeout(() => {
                        this.takeAndSleepScan_Auto(true);
                    }, 2000); 
                    return; 
                } else {
                    this.log('Σ Calculando promedio final de los 4 puntos...', 'log-warn');
                    const averaged = new Array(125).fill(0);
                    for (let i = 0; i < 125; i++) {
                        let sum = 0;
                        for (let s = 0; s < 4; s++) sum += this.multiScanBuffer[s][i];
                        averaged[i] = sum / 4;
                    }
                    spectrum = [...averaged];
                    this.isAveragingInProgress = false;
                    this.multiScanBuffer = [];
                    const progContainer = document.getElementById('progressContainer');
                    if (progContainer) progContainer.style.display = 'none';
                }
            }

            // --- SUAVIZADO DIGITAL ---
            const smoothed = [...spectrum];
            for (let i = 1; i < smoothed.length - 1; i++) {
                smoothed[i] = (spectrum[i-1] + spectrum[i] + spectrum[i+1]) / 3;
            }
            spectrum = smoothed;

            this.lastSpectrum = [...spectrum];
            this.pktCount++;
            const valPkt = document.getElementById('valPkt');
            if (valPkt) valPkt.textContent = `${spectrum.length} / ${this.pktCount}`;
            this.log(`Espectro Recibido (${this.HW_REPS} reps de hardware).`, 'log-sys');
            
            let displayData = [...spectrum];
            const target = this.scanTarget;

            if (this.showAbsorbance && this.referenceData.dark && this.referenceData.white) {
                displayData = spectrum.map((S, i) => {
                    const D = this.referenceData.dark![i] || 0;
                    const W = this.referenceData.white![i] || 1;
                    const R = Math.max((S - D) / (W - D <= 0 ? 1 : W - D), 0.00001);
                    return -Math.log10(R);
                });
                this.chart.options.scales.y.title = { display: true, text: 'Absorbancia (AU)' };
            } else if (target === 'white' && this.referenceData.dark) {
                displayData = spectrum.map((W, i) => Math.max(W - (this.referenceData.dark![i] || 0), 0));
                this.chart.options.scales.y.title = { display: true, text: 'Intensidad Neta (White - Dark)' };
            } else if (target === 'sample' && this.referenceData.dark) {
                displayData = spectrum.map((S, i) => Math.max(S - (this.referenceData.dark![i] || 0), 0));
                this.chart.options.scales.y.title = { display: true, text: 'Intensidad Neta (Raw - Dark)' };
            } else {
                this.chart.options.scales.y.title = { display: true, text: 'ADC (Crudo)' };
            }

            this.updateChart(displayData, spectrum.length);
            this.saveScan(spectrum);
            
            if (target === 'white') {
                this.referenceData.white = [...spectrum];
                this.log("✓ Referencia 'WHITE' guardada.", "log-default");
                this.sendCmdData([0x21, 0x00, 0x00], 'lamp_off');
            } else if (target === 'dark') {
                this.referenceData.dark = [...spectrum];
                this.log("✓ Referencia 'DARK' guardada.", "log-default");
            } else if (target === 'sample') {
                this.log('✓ Análisis completado.', 'log-default');
                this.sendCmdData([0x21, 0x00, 0x00], 'lamp_off');
            }
        } finally {
            if (!this.isAveragingInProgress) {
                this.scanTarget = false;
                this.updateChartStatus();
                this.setLed('ADC', true, 'on-green');
            }
        }
    }

    async takeAndSleepScan_Auto(withLamp: boolean) {
        this.rxBuffer = [];
        this.inPacket = false;
        this.setLed('ADC', true, 'on-orange');
        const presetId = withLamp ? 0x01 : 0x00;
        await this.sendCmdData([34, presetId, 0x00], 'scan_start_act');
        await this.sleep(2000); 
        this.sendCmdData([80, this.PROPERTY.GET], 'scan_read_wait');
    }

    toggleAbsorbance() {
        if (!this.referenceData.dark || !this.referenceData.white) {
             this.log('Faltan referencias Dark/White para Absorbancia.', 'log-err'); 
             alert('Debes establecer primero tu referencia DARK y WHITE.');
             return; 
        }
        this.showAbsorbance = !this.showAbsorbance;
        this.log(this.showAbsorbance ? 'Mostrando Absorbancia (Log 1/R)' : 'Mostrando ADC Raw.', 'log-sys');
        this.updateChartStatus();
        if (this.lastSpectrum.length > 0) this.updateChart(this.lastSpectrum, this.lastSpectrum.length);
    }
    
    updateChartStatus() {
        // Actualiza el CSS de los botones grandes del Wizard de Calibración
        const dBtn = document.getElementById('btnDark');
        if (dBtn) dBtn.style.border = this.referenceData.dark ? '1px solid var(--primary)' : '1px solid var(--border)';
        if (dBtn) dBtn.style.color = this.referenceData.dark ? 'var(--primary)' : 'var(--text)';
        
        const wBtn = document.getElementById('btnWhite');
        if (wBtn) wBtn.style.border = this.referenceData.white ? '1px solid var(--primary)' : '1px solid var(--border)';
        if (wBtn) wBtn.style.color = this.referenceData.white ? 'var(--primary)' : 'var(--text)';
    }

    exportCSV() {
        if (!this.lastSpectrum.length) { this.log('Sin datos para exportar.', 'log-warn'); return; }
        
        // Cabeceras: 125 Longitudes de onda con ajuste lineal exacto
        const wavelengths = Array.from({length: 125}, (_, i) => {
            const nm = 908.1 + (6.19435 * i);
            return nm.toFixed(4); // 4 decimales para máxima compatibilidad
        });
        
        const header = ["Sample Name", ...wavelengths, "Serial Number", "User Name", "Temperature", "Integration Time (ms)", "Replicates"];
        
        // Extraer valores actuales de la UI
        const temp = document.getElementById('valTemp')?.textContent?.replace('°C', '') || "25.0";
        const exp = document.getElementById('valExp')?.textContent?.replace(' ms', '') || "12.5";
        const sampleName = `Scan_${new Date().toISOString().replace(/[:.]/g, '-')}`;
        
        // Calcular absorbancia si hay referencias
        const dataRow = this.lastSpectrum.map((S, i) => {
            if (this.referenceData.dark && this.referenceData.white) {
                const D = this.referenceData.dark[i] || 0;
                const W = this.referenceData.white[i] || 1;
                const R = Math.max((S - D) / (W - D <= 0 ? 1 : W - D), 0.0001);
                return (-Math.log10(R)).toFixed(5);
            }
            return S.toFixed(0); // Si no hay referencias, exportar ADC
        });

        const row = [
            sampleName,
            ...dataRow,
            "M1-0000343", 
            "SpectraNir User",
            temp,
            exp,
            "4" // Basado en el promediado multi-punto
        ];

        const csvContent = [header.join(','), row.join(',')].join('\n');
        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement("a");
        const url = URL.createObjectURL(blob);
        link.setAttribute("href", url);
        link.setAttribute("download", `SpectraNir_${sampleName}.csv`);
        link.style.visibility = 'hidden';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        
        this.log('✓ CSV exportado con formato compatible Viavi.', 'log-default');
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
                        <div className="logo-text">Spectra<em>Nir</em></div>
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
                    </div>

                    <div className="history-section">
                        <div className="history-hdr">
                            <div className="sec-label">Historial de Calidad</div>
                            <button className="h-clear" onClick={() => app()?.clearHistory()}>Limpiar</button>
                        </div>
                        <div id="historyList" className="history-list">
                            <div className="dim-text" style={{fontSize:'.65rem', padding:'10px'}}>Sin historial...</div>
                        </div>
                    </div>

                    <button id="btnDisc" className="btn btn-danger" onClick={() => app()?.disconnect()} disabled style={{ marginTop: '10px' }}>
                        DESCONECTAR EQUIPO
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
                            <div className="m-label">VOLTAJE HW</div>
                            <div className="m-val green" id="valBat">— V</div>
                        </div>
                        <div className="metric m-purple">
                            <div className="m-label">PÍXELES / PAQUETES</div>
                            <div className="m-val purple" id="valPkt">— / —</div>
                        </div>
                    </div>

                    <div id="progressContainer" style={{display:'none', background:'rgba(0,184,217,0.05)', borderRadius:'6px', padding:'12px', border:'1px solid rgba(0,184,217,0.1)', marginBottom:'15px'}}>
                        <div style={{display:'flex', justifyContent:'space-between', marginBottom:'10px'}}>
                            <span className="label" style={{fontSize:'0.75rem', color:'var(--primary)', fontFamily:'Share Tech Mono', fontWeight:'bold'}}>PROGRESO DEL ESCANEO (100 PROMEDIOS)</span>
                            <span id="progressText" className="val" style={{fontSize:'0.75rem', color:'var(--primary)', fontFamily:'Share Tech Mono'}}>0%</span>
                        </div>
                        <div style={{width:'100%', height:'8px', background:'rgba(255,255,255,0.05)', borderRadius:'4px', overflow:'hidden', border:'1px solid rgba(255,255,255,0.05)'}}>
                            <div id="progressBar" style={{width:'0%', height:'100%', background:'var(--primary)', transition:'width 0.15s ease'}}></div>
                        </div>
                    </div>

                    <div className="calibration-wizard" style={{ display: 'flex', gap: '10px', backgroundColor: 'var(--panel)', padding: '15px', borderRadius: '8px', border: '1px solid var(--border)', boxShadow: '0 4px 6px -1px rgba(0,0,0,0.03)', marginBottom: '15px', alignItems: 'center' }}>
                        <div style={{ color: 'var(--text)', fontSize: '0.8rem', fontWeight: 'bold', width: '150px' }}>FLUJO DE<br/>CALIBRACIÓN:</div>
                        
                        <button id="btnDark" className="btn" onClick={() => app()?.setDarkReference()} style={{ flex: 1, backgroundColor: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)', boxShadow: '0 2px 4px rgba(0,0,0,0.02)' }}>
                            <span style={{opacity: 0.6, marginRight: '5px'}}>[1]</span> OSCURIDAD
                        </button>
                        
                        <button id="btnWhite" className="btn" onClick={() => app()?.setWhiteReference()} style={{ flex: 1, backgroundColor: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)', boxShadow: '0 2px 4px rgba(0,0,0,0.02)' }}>
                            <span style={{opacity: 0.6, marginRight: '5px'}}>[2]</span> BLANCO
                        </button>
                        
                        <button id="btnAbs" className="btn" onClick={() => app()?.scanSample()} style={{ flex: 1, backgroundColor: 'var(--primary)', color: '#fff', fontWeight: 'bold', boxShadow: '0 4px 6px rgba(14,165,233,0.15)' }}>
                            <span style={{opacity: 0.6, marginRight: '5px'}}>[3]</span> MUESTRA (ABS)
                        </button>
                    </div>

                    <div className="chart-panel">
                        <div className="chart-hdr">
                            <span className="chart-title">ESPECTRO NIR — 128 PÍXELES InGaAs · 16-BIT BIG ENDIAN</span>
                            <div className="chart-btns">
                                <button className="chip-btn" onClick={() => app()?.toggleAbsorbance()}>Adc / Absorbancia</button>
                                <button className="chip-btn" onClick={() => app()?.clearChart()}>Limpiar</button>
                                <button className="chip-btn" onClick={() => app()?.exportCSV()}>CSV</button>
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
                                <button className="chip-btn" id="btnPause" onClick={(e: any) => { 
                                    const a = app(); 
                                    if (a) { 
                                        a.consolePaused = !a.consolePaused; 
                                        e.target.innerText = a.consolePaused ? '▶ Reanudar' : '⏸ Pausar'; 
                                        e.target.style.color = a.consolePaused ? 'var(--primary)' : ''; 
                                    } 
                                }}>⏸ Pausar</button>
                            </div>
                            <div className="console" id="console" style={{ fontSize: '13px', lineHeight: '1.4' }}>
                                <div className="log-sys">{'>'} MicroNIR Controller v6.0 — Modo Producción.</div>
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
