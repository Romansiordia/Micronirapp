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
            LAMP:    0x4C, // 'L'
            SCAN:    0x53, // 'S'
            BATTERY: 0x42, // 'B'
            VERSION: 0x56,
            TEMP:    0x54,
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
        ['btnWarm','btnBat','btnDisc'].forEach(id => {
            const el = document.getElementById(id) as HTMLButtonElement;
            if (el) el.disabled = !on;
        });
        
        // El botón de escaneo se habilita SOLO cuando se recibe el ACK de la lámpara
        const btnScan = document.getElementById('btnScan') as HTMLButtonElement;
        if (btnScan) btnScan.disabled = true;

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
            this.log('Analizando perfiles UART del DLL de Viavi (GATT Base UUID)...', 'log-tx');

            // Según el DLL de MicroNIR:
            // BluetoothBaseUuid = [0, 0, 0, 0, 0, 0, 16, 0, 128, 0, 0, 128, 95, 155, 52, 251]
            // Usamos las formas normalizadas al 100% como requiere la API de Windows
            
            this.log('Aplicando Arquitectura BLE Estricta...', 'log-warn');
            const VIAVI_APK_SVC = '0000ff01-0000-1000-8000-00805f9b34fb';
            const VIAVI_APK_TX  = '0000ff02-0000-1000-8000-00805f9b34fb';
            const VIAVI_APK_RX  = '0000ff03-0000-1000-8000-00805f9b34fb';
            
            // Para asegurar la compatibilidad tanto en móvil como en PC:
            let bleDevice = null;
            try {
                this.log('Attempt 1: Filtrado de nombre estricto...', 'log-sys');
                // Intentamos primero con FILTRO ESTRICTO (El preferido por la DLL)
                bleDevice = await (navigator as any).bluetooth.requestDevice({
                    filters: [
                        { namePrefix: 'MicroNIR' }
                    ],
                    optionalServices: [VIAVI_APK_SVC, '49535343-fe7d-4ae5-8fa9-9fafd205e455', '00001800-0000-1000-8000-00805f9b34fb', '00001801-0000-1000-8000-00805f9b34fb']
                });
            } catch (e) {
                this.log('Attempt 2: Escaneo general (Fallback)...', 'log-sys');
                // Fallback de rescate si el nombre es distinto (ej. 'MN-XXXX')
                bleDevice = await (navigator as any).bluetooth.requestDevice({
                    acceptAllDevices: true,
                    optionalServices: [VIAVI_APK_SVC, '49535343-fe7d-4ae5-8fa9-9fafd205e455', '00001800-0000-1000-8000-00805f9b34fb', '00001801-0000-1000-8000-00805f9b34fb']
                });
            }

            this.bleDevice = bleDevice;
            this.log(`Emparejado: "${this.bleDevice.name}"`);
            this.bleDevice.addEventListener('gattserverdisconnected', () => this.onDisconnect());

            this.setStatus('GATT CONNECT...', 'connecting');
            this.gattServer = await this.bleDevice.gatt.connect();
            
            this.log('Esperando inicialización de servicios (Latencia industrial)...', 'log-sys');
            await this.sleep(1500); // CRÍTICO: Pausa para que el hardware exponga el GATT tras conectar
            
            this.log('Solicitando servicios primarios...', 'log-tx');
            let services = [];
            try {
                services = await this.gattServer.getPrimaryServices();
            } catch (e) {
                this.log('ERROR CRÍTICO: El Sistema Operativo bloqueó el escaneo GATT.', 'log-err');
                this.log('-> SOLUCIÓN PC: Tu Windows lo capturó como "Bluetooth Clásico SPP". Usa el botón "CONECTAR (MODO USB)" y selecciona el Puerto COM asignado a tu Bluetooth.', 'log-warn');
                this.log('-> SOLUCIÓN MÓVIL: Ve a Ajustes > Bluetooth. Da en "Olvidar" o "Desvincular" al MicroNIR, apaga el Bluetooth, enciéndelo y reintenta SIN vincularlo desde los ajustes.', 'log-warn');
                throw new Error('GATT bloqueado por perfil SPP activo o Caché del S.O.');
            }
            this.log(`Servicios detectados: ${services.length}`, 'log-warn');

            let targetTx = null;
            let targetRx = null;

            // Mapeo detallado de servicios encontrados
            for (const svc of services) {
                const uuid = svc.uuid.toLowerCase();
                this.log(`🔍 UUID Detectado: ${uuid}`, 'log-sys');

                // Si es el servicio FF01 o el ISSC o uno no estándar
                try {
                    const chars = await svc.getCharacteristics();
                    for (const c of chars) {
                        const cUuid = c.uuid.toLowerCase();
                        const p = c.properties;
                        
                        // Lógica de asignación por UUID exacto (APK) o Propiedades (Genérico)
                        if (cUuid === VIAVI_APK_TX || (p.write || p.writeWithoutResponse)) {
                            if (!targetTx) targetTx = c;
                        }
                        if (cUuid === VIAVI_APK_RX || (p.notify || p.indicate)) {
                            if (!targetRx) targetRx = c;
                        }
                    }
                    if (targetTx && targetRx) {
                        this.log(`¡CONEXIÓN DE DATOS ESTABLECIDA EN ${uuid.slice(0,8)}!`, 'log-warn');
                        break;
                    }
                } catch (e) {
                    continue;
                }
            }

            if (!targetTx || !targetRx) {
                this.log('ERROR CRÍTICO: Canal UART invisible en BLE.', 'log-err');
                this.log('DIAGNÓSTICO: Si estás en PC (Windows/Mac), tu sistema operativo vinculó el MicroNIR como Bluetooth Clásico (SPP) creando un Puerto COM virtual. Eso oculta los servicios BLE.', 'log-warn');
                this.log('-> SOLUCIÓN EN PC: Usa el botón "CONECTAR (MODO USB)" y selecciona el Puerto COM de tu Bluetooth.', 'log-sys');
                this.log('-> SOLUCIÓN EN MÓVIL: Ve a Ajustes, Desvincula el equipo, reinicia el teléfono e intenta nuevamente.', 'log-sys');
                throw new Error('Canal de datos oculto por el Sistema Operativo.');
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

    async sendCmd(cmdByte: number, payload: number[] | null = null, cmdType = 'generic') {
        // Estructura: [STX] [LEN] [CMD] [PAYLOAD...] [DUMMY_CHECKSUM] [ETX]
        const safePayload = payload || [];
        
        // Hipótesis: El MCU espera un byte extra antes del ETX (Checksum o Estado).
        // Ajustamos el LEN para que incluya los argumentos + 1 byte extra (el dummy).
        // Nota: No incluimos el CMD en el LEN según nuestras pruebas anteriores.
        const len = safePayload.length + 1; 
        
        const dummyChecksum = 0x00; // Enviamos 0x00 para ver si el MCU lo rechaza pero no se cuelga.
        
        const frame = new Uint8Array([this.STX, len, cmdByte, ...safePayload, dummyChecksum, this.ETX]);
        const cmdName = Object.keys(this.CMD).find(k => (this.CMD as any)[k] === cmdByte) || `0x${cmdByte.toString(16)}`;

        let timeout = this.TIMEOUT_MS;
        if (cmdType === 'lamp')    timeout = 1000;
        if (cmdType === 'scan')    timeout = 1500;
        if (cmdType === 'battery') timeout = 300;
        if (cmdType === 'ack')     timeout = 100;

        this.lastCmdType = cmdType;

        try {
            if (this.mode==='usb' && this.serialWriter) {
                await this.serialWriter.write(frame);
            } else if (this.txChar) {
                if (this.txChar.properties.writeWithoutResponse) {
                    await this.txChar.writeValueWithoutResponse(frame);
                } else {
                    await this.txChar.writeValue(frame);
                }
            } else {
                this.log('Sin canal TX.', 'log-err'); return;
            }
            this.log(`TX [${cmdName}] (${cmdType}): ${Array.from(frame).map(b=>'0x'+b.toString(16).padStart(2,'0')).join(' ')}`, 'log-tx');
            this.startTimeoutBar();
            this.scheduleTimeout(timeout);
        } catch (e: any) {
            this.log(`Fallo TX: ${e.message}`, 'log-err');
        }
    }

    scheduleTimeout(ms: number) {
        clearTimeout(this.responseTimeout);
        this.responseTimeout = setTimeout(() => {
            this.stopTimeoutBar(false);
            this.log(`TIMEOUT (${ms}ms): MCU no respondió. Verifica: DTR HIGH, conector, latency FTDI.`, 'log-err');
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
        
        // Enviamos 'X\r' (El ReadStatus puro revelado de dnSpy) cada 5 segundos
        // JDSU Firmware es super estricto con NO recibir el linefeed \n 
        this.heartbeatTimer = setInterval(async () => {
            if (!this.serialWriter && !this.txChar) return;
            silentCounter += 5;
            
            // X \r (Command = X, Read Status) = 58 0D
            const ping = new Uint8Array([0x58, 0x0D]); 
            try {
                if (this.mode === 'usb' && this.serialWriter) {
                    await this.serialWriter.write(ping);
                } else if (this.txChar) {
                    await this.txChar.writeValueWithoutResponse(ping);
                }
                this.log(`Heartbeat de Estado enviado (X\\r): [58 0D]. Esperando RX... (${silentCounter}s)`, 'log-sys');
            } catch (e: any) {}
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
        // crc = (ushort)(crc >> 8 | (int)crc << 8);
        crc = ((crc >>> 8) | (crc << 8)) & 0xFFFF;
        // crc ^= (ushort)value;
        crc ^= (value & 0xFF);
        // crc ^= (ushort)((crc & 255) >> 4);
        crc ^= ((crc & 0xFF) >>> 4);
        // crc ^= (ushort)(crc << 8 << 4);
        crc ^= ((crc << 12) & 0xFFFF);
        // crc ^= (ushort)((crc & 255) << 5);
        crc ^= (((crc & 0xFF) << 5) & 0xFFFF);
        
        return crc & 0xFFFF;
    }

    // Byte-Stuffing & CRC builder como lo hace OnSiteW
    private encodePacket(payload: Uint8Array): Uint8Array {
        let crc = 0xFFFF; // ushort.MaxValue
        const outStream: number[] = [];
        
        outStream.push(this.STX); // start byte
        
        // Iterar el payload, hacer bit-stuffing y sumar al CRC la versión RAW
        for (let i = 0; i < payload.length; i++) {
            const val = payload[i];
            if (val === this.STX || val === this.ETX || val === this.SUB) {
                outStream.push(this.SUB);
                outStream.push(val ^ 0x80); // XOR 128
                crc = this.updateCRC(crc, val);
            } else {
                outStream.push(val);
                crc = this.updateCRC(crc, val);
            }
        }
        
        const crcLSB = crc & 0xFF;
        const crcMSB = (crc >>> 8) & 0xFF;
        
        const attachCrcByte = (val: number) => {
            if (val === this.STX || val === this.ETX || val === this.SUB) {
                outStream.push(this.SUB);
                outStream.push(val ^ 0x80);
            } else {
                outStream.push(val);
            }
        };

        attachCrcByte(crcLSB);
        attachCrcByte(crcMSB);

        outStream.push(this.ETX); // end byte
        
        return new Uint8Array(outStream);
    }
    
    // Método auxiliar para armar el paquete crudo con LEN incluído antes de Encriptar
    private prepareRawViaviPacket(innerPayload: Uint8Array): Uint8Array {
        // La trama requiere que su longitud total esté al principio.
        // Formato estándar de comandos: [Length(1 byte)] [Payload]
        const len = innerPayload.length;
        const packet = new Uint8Array(1 + len);
        packet[0] = len;
        packet.set(innerPayload, 1);
        return packet;
    }

    async lampOn() {
        if (this.lampConfirmed) {
            this.log('Lámpara ya encendida y confirmada.', 'log-warn');
            return;
        }
        
        this.log('Iniciando BATERÍA ESCÁNER FINAL VIAVI / JDSU (ASCII + OnSiteW)...', 'log-warn');
        this.setLed('LAMP', true, 'on-orange');
        this.lampReady = false;
        this.lampConfirmed = false;
        
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }

        const tryPck = async (name: string, pck: Uint8Array) => {
            this.log(`\n=== Enviando: ${name} ===`, 'log-sys');
            this.log(`TX BIN COMPLETO: ${Array.from(pck).map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ')}`, 'log-tx');
            try {
                if (this.mode === 'usb' && this.serialWriter) await this.serialWriter.write(pck);
                else if (this.txChar) await this.txChar.writeValueWithoutResponse(pck);
            } catch (e: any) { this.log(`Error TX: ${e.message}`, 'log-err'); }
            await this.sleep(500);
        };

        // --- ASALTO FINAL COMBINADO (JDSU UNIVERSAL DRIVER vs VIAVI ONSITE W) ---

        // 1. EL TRUCO CLÁSICO Y SUCIO: ASCII DIRECTO (MicroNIR 1700/2200 Clásico)
        // SetLampOn() literal del dnSpy: this.WriteBinaryCommand("L0\r")
        const asciiCmd = new TextEncoder().encode("L0\r");
        await tryPck("LampON ASCII Directo (MicroNIR Universal) ['L0\\r']", asciiCmd);
        
        // Vamos a probar limpiar el buffer del hardware con un Carriage Return extra si no entendió 
        const asciiCmdClean = new TextEncoder().encode("\rL0\r");
        await tryPck("LampON ASCII CleanBuffer ['\\rL0\\r']", asciiCmdClean);

        // 2. EL COMANDO ASCII ENCRIPTADO EN LA CUPULA ONSITE-W (Mobile MicroNIR)
        // Tal vez la placa espera los strings dentro del sobre seguro.
        const wrappedAscii = this.prepareRawViaviPacket(asciiCmd);
        await tryPck("LampON ASCII Encriptado (Viavi OnSite) [STX...L0\\r...ETX]", this.encodePacket(wrappedAscii));

        // 3. COMANDO BINARIO DE NUEVA GENERACIÓN (CompositeCommand de Factory)
        // Asumimos que Comando = L (0x4C) y Estado = ON (0x00) (Por la constante pública const int On = 0; const int Off = 1;)
        const binA = this.prepareRawViaviPacket(new Uint8Array([0x4C, 0x00])); 
        await tryPck("LampON BINARIO 4C 00 (Viavi OnSite)", this.encodePacket(binA));

        // 4. COMANDO BINARIO COMPUESTO (CompositeCommand con PassKey por si nos topamos con un Battery/Firmware write)
        // Comando = 0x4C, LampState = 0x00, PassKey
        const binB = this.prepareRawViaviPacket(new Uint8Array([0x4C, 0x00, ...this.PASSKEY]));
        await tryPck("LampON BINARIO 4C 00 + PK (Viavi OnSite)", this.encodePacket(binB));

        if (this.lampConfirmed) {
            this.setLed('LAMP', true, 'on-green');
            this.log('\n¡ÉXITO ABSOLUTO! EL CÓDIGO FUENTE DE DESARROLLO ROMPIÓ LA CHAPA.', 'log-warn');
        } else {
            this.log('Revisando el Sniffer ante el Escáner Final Combinado...', 'log-warn');
        }

        this.startHeartbeat();
    }

    async scan() {
        if (!this.connected) { this.log('No conectado.', 'log-err'); return; }
        if (!this.lampConfirmed) {
            this.log('⚠ WATCHDOG: No se puede escanear. Lámpara no confirmada (Falta ACK).', 'log-err');
            return;
        }

        const now = Date.now();
        if (this.lastScanTime && (now - this.lastScanTime) < 600) {
            this.log(`Espera 600ms entre escaneos. Última vez: ${now - this.lastScanTime}ms.`, 'log-warn');
            return;
        }
        this.lastScanTime = now;

        this.log('Disparando escaneo (CMD S=0x53): integración ADC 128 píxeles InGaAs...', 'log-warn');
        this.setLed('ADC', true, 'on-orange');
        this.rxBuffer  = [];
        this.inPacket  = false;
        this.ftdiByteCount = 0;
        await this.sendCmd(this.CMD.SCAN, null, 'scan');
    }

    async batteryPing() {
        if (!this.connected) { this.log('No conectado.', 'log-err'); return; }
        this.log('Battery Ping [D: 42] — CMD 0x44 0x2A...', 'log-warn');
        await this.sendCmd(this.CMD.BATTERY, [0x2A], 'battery');
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
                // Extraer el paquete completo sin el STX ni el ETX para compatibilidad con processPacket
                const frame = this.bleBuffer.slice(startIdx + 1, endIdx);
                this.log(`\n> TRAMA BLE ENSAMBLADA: [02] ${frame.map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ')} [03]`, 'log-warn');
                
                // Pasar la trama al parseador lógico principal 
                this.clearTimeout_();
                this.processPacket(frame);

                // Eliminar la trama procesada del buffer
                this.bleBuffer.splice(0, endIdx + 1);
                
                // Buscar la siguiente trama
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
                this.processPacket([...this.rxBuffer]);
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

    handleAck() {
        if (this.lastCmdType === 'lamp') {
            this.log('Lámpara confirmada por MCU. Esperando estabilidad térmica (2500ms)...', 'log-warn');
            setTimeout(() => {
                this.lampConfirmed = true;
                this.setLed('LAMP', true, 'on-green');
                this.log('Lámpara estabilizada. SISTEMA LISTO PARA ESCANEO.', 'log-default');
                
                // Habilitar botón de escaneo en la UI
                const btnScan = document.getElementById('btnScan') as HTMLButtonElement;
                if (btnScan) btnScan.disabled = false;
            }, 2500);
        }
    }

    parseTextResponse(msg: string) {
        const up = msg.toUpperCase();

        if (up.includes('ERR_OVERHEAT') || up.includes('OVERHEAT') || up.includes('THERMAL')) {
            this.log('⚠⚠⚠ WATCHDOG TÉRMICO: MCU superó 50°C. Lámpara cortada automáticamente.', 'log-err');
            this.setLed('LAMP', true, 'on-red');
            this.lampConfirmed = false;
            const valTemp = document.getElementById('valTemp');
            if (valTemp) valTemp.textContent = '>50 °C [ERROR]';
            return;
        }

        if (up.startsWith('T:') || up.startsWith('T ')) {
            const v = msg.split(':')[1]?.trim() || msg.slice(2).trim();
            const valTemp = document.getElementById('valTemp');
            if (valTemp) valTemp.textContent = v + ' °C';
            const t = parseFloat(v);
            if (t > 45) {
                this.log(`⚠ Temperatura elevada: ${v}°C (watchdog en 50°C)`, 'log-warn');
                this.setLed('MCU', true, 'on-orange');
            } else {
                this.setLed('MCU', true, 'on-blue');
            }
            return;
        }

        if (up.startsWith('B:') || up.startsWith('B ')) {
            const v = msg.split(':')[1]?.trim() || msg.slice(2).trim();
            const valBat = document.getElementById('valBat');
            if (valBat) valBat.textContent = v + ' %';
            const pct = parseInt(v);
            if (pct < 20) {
                this.log(`⚠ Batería baja: ${v}%`, 'log-warn');
                this.setLed('MCU', true, 'on-orange');
            } else {
                this.setLed('MCU', true, 'on-green');
            }
            return;
        }

        if (up.startsWith('E:') || up.startsWith('E ')) {
            const v = msg.split(':')[1]?.trim() || msg.slice(2).trim();
            const valExp = document.getElementById('valExp');
            if (valExp) valExp.textContent = v + ' ms';
            return;
        }

        if (up.startsWith('V:') || up.includes('VER') || up.includes('MICRONIR') || up.includes('FIRMWARE')) {
            this.log(`Firmware: ${msg}`, '');
            const devId = document.getElementById('devId');
            if (devId) devId.textContent = msg.slice(0,20);
            return;
        }

        if (up.includes('READY') || up.includes('OK') || up.includes('SUCCESS')) {
            this.log(`MCU: ${msg}`, 'log-default');
            return;
        }

        this.log(`MSG no clasificado: ${msg}`, 'log-sys');
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
                            BLUETOOTH
                        </button>
                        <button className="conn-tab" id="tabUSB" onClick={() => app()?.setMode('usb')}>
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><rect x="7" y="8" width="10" height="8" rx="1"/><path d="M12 2v6M8 22h8M12 16v6"/></svg>
                            USB/SERIAL
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
                            Conectar Bluetooth
                        </button>
                    </div>

                    <div id="usbSection" style={{display:'none'}}>
                        <button className="btn btn-primary" onClick={() => app()?.connectUSB()}>
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><rect x="7" y="8" width="10" height="8" rx="1"/><path d="M12 2v6"/></svg>
                            Conectar USB/FTDI
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
                            Batería
                        </button>
                    </div>

                    <button id="btnScan" className="btn btn-scan" onClick={() => app()?.scan()} disabled>
                        ▶ INICIAR ESCANEO NIR
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

                    <div className="console-wrap">
                        <div className="sec-label">Monitor UART / Protocolo</div>
                        <div className="console" id="console">
                            <div className="log-sys">{'>'} MicroNIR Controller v6.0 — Protocolo FTDI activo.</div>
                            <div className="log-sys">{'>'} DTR controla VCC del MCU. Sin DTR HIGH = equipo muerto.</div>
                            <div className="log-sys">{'>'} Stripping de 2 bytes de estado FTDI cada 62 bytes habilitado.</div>
                            <div className="log-sys">{'>'} Secuencia: DTR↑ → RTS↑ → CMD 'L' → CMD 'S' → STX/ETX parse.</div>
                        </div>
                        <div className="sec-label" style={{marginTop:'5px'}}>Monitor de Datos Crudos (Hex)</div>
                        <div id="rawMonitor" style={{height:'60px', background:'#000', border:'1px solid var(--border)', borderRadius:'4px', overflowY:'auto', padding:'4px', color:'var(--purple)', fontSize:'0.6rem', fontFamily:'monospace'}}>
                            Esperando datos...
                        </div>
                    </div>
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
