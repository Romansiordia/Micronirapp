/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useRef, useState } from 'react';
import { Chart, registerables } from 'chart.js';
import { Cpu, Clock, Thermometer, Battery, Activity, Moon, Sun, Zap, Lock, Unlock, PowerOff, Database, FileJson, ChevronDown, Plus, Trash2 } from 'lucide-react';
import { PredictionModel, PredictionResult, ModelJSON } from './types';
import { predict } from './services/chemometrics';

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
    onCalibUpdate?: (status: { dark: boolean, white: boolean }) => void;
    lampConfirmed: boolean;
    ignoreRxUntil: number;
    VAL: { ON: number; OFF: number };
    history: { id: string, name: string, lot?: string, data: number[], time: number }[];
    sampleData: { id: string; name: string; lot: string };
    onPrediction?: (res: PredictionResult | null) => void;
    onPredictionState?: (loading: boolean) => void;
    currentModel: ModelJSON | null = null;

    constructor() {
        this.STX = 0x02;
        this.ETX = 0x03;
        this.CR  = 0x0D;
        this.sampleData = { id: '', name: '', lot: '' };
        
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
                        grid: { color: 'rgba(255,255,255,0.05)' },
                        ticks: { color: '#f1f5f9', font: { family: 'Share Tech Mono', size: 10, weight: 'bold' } },
                        title: { display: true, text: 'Intensidad (Counts)', color: '#0ea5e9', font: { size: 11, family: 'Share Tech Mono', weight: 'bold' } }
                    },
                    x: {
                        grid: { color: 'rgba(255,255,255,0.05)' },
                        ticks: { color: '#94a3b8', font: { family: 'Share Tech Mono', size: 9 }, maxTicksLimit: 12 },
                        title: { display: true, text: 'Longitud de onda (nm)', color: '#94a3b8', font: { size: 10, family: 'Share Tech Mono' } }
                    }
                },
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        backgroundColor: '#1e293b',
                        borderColor: '#334155', borderWidth: 1,
                        titleColor: '#38bdf8', bodyColor: '#f1f5f9',
                        titleFont: { family: 'Share Tech Mono' },
                        bodyFont:  { family: 'Share Tech Mono' },
                        callbacks: {
                            title: (items: any) => `${items[0].label} nm`,
                            label: (item: any)  => ` Intensidad: ${item.raw}`
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
        
        // 5. Configuración Inicial de Integración (12.5 ms)
        await this.setIntegrationTime(12.5);
        
        // 6. Configuración de Réplicas de Hardware (50)
        await this.setHardwareReplicas(50);

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
            this.setStatus('CONECTADO (VIAVI)', 'connected pulse-live');
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
            this.setStatus('CONECTADO USB', 'connected pulse-live');
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

    async setIntegrationTime(ms: number) {
        if (!this.connected) return;
        // Según DLL: El valor se maneja en microsegundos (Us)
        const hwValue = Math.round(ms * 1000);
        this.log(`Configurando Tiempo de Integración: ${ms} ms (HW: ${hwValue} us)...`, 'log-sys');
        
        // Comando 0x0A (SET INTEGRATION) + 4 bytes valor + 4 bytes passkey
        const cmd = this.createGenericSetUintCommandWithPasskey(this.CMD.INTEGRATION_TIME, hwValue);
        await this.sendCmdData(cmd, 'set_exp');

        // Actualizar UI inmediatamente
        const elExp = document.getElementById('valExp');
        if (elExp) elExp.textContent = ms.toFixed(1);
    }

    async setHardwareReplicas(reps: number) {
        if (!this.connected) return;
        this.log(`Configurando Réplicas de Hardware: ${reps}...`, 'log-sys');
        this.HW_REPS = reps;
        
        // Comando 0x0B (LAMP_DWELLS / Scans per Average) + 4 bytes valor + 4 bytes passkey
        const cmd = this.createGenericSetUintCommandWithPasskey(this.CMD.LAMP_DWELLS, reps);
        await this.sendCmdData(cmd, 'set_reps');
    }

    async batteryPing() {
        if (!this.connected) return;
        this.log('\n--- DIAGNÓSTICO BATERÍA ---', 'log-warn');
        
        if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }

        // Manda el comando BATTERY (0x42)
        const payload = this.createGenericGetCommand(this.CMD.BATTERY);
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

    async processPacketRaw(buf: number[]) {
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
            await this.processSpectrum(pixelData);

            // EXTRACCIÓN DE TELEMETRÍA (Metadata bytes 257-288) según DLL de VIAVI
            if (payload.length >= 288) {
                // Notar: index = DLL_offset + 1 (porque payload[0] es el CMD 0x50)
                // VIAVI usa Big Endian para empaquetar bytes (Ver UInt32BytePacker en DLL)

                // 1. Tiempo de Integración (DLL Offset 264 - 4 bytes Big Endian)
                const iTime = (payload[265] << 24) | (payload[266] << 16) | (payload[267] << 8) | payload[268];
                const valExp = document.getElementById('valExp');
                if (valExp && iTime > 0) {
                    const expMs = (iTime / 1000).toFixed(1); // Us a Ms
                    valExp.textContent = `${expMs} ms`;
                }

                // 2. Capacidad de Batería (DLL Offset 273 - 1 byte)
                const pctReal = payload[274]; 
                const elBat = document.getElementById('valBat');
                if (elBat) {
                    elBat.textContent = `${pctReal}%`;
                    if (pctReal < 20) elBat.className = "m-val red";
                    else if (pctReal < 50) elBat.className = "m-val orange";
                    else elBat.className = "m-val green";
                }

                // 3. Temperatura (DLL Offset 260 - 2 bytes Big Endian con lógica 13-bits)
                let tRaw = (payload[261] << 8) | payload[262];
                const mask = 8191; // 0x1FFF (13 bits)
                const signBit = 4096; // 2^12
                tRaw &= mask;
                let tempC = 0;
                if ((tRaw & signBit) === signBit) {
                    tempC = (tRaw - 8192) / 16.0;
                } else {
                    tempC = tRaw / 16.0;
                }

                const elTemp = document.getElementById('valTemp');
                if (elTemp && tempC > -50 && tempC < 150) {
                    elTemp.textContent = `${tempC.toFixed(1)}°C`;
                }

                // 4. Spectra Counter (DLL Offset 256 - 4 bytes Big Endian)
                const sCount = (payload[257] << 24) | (payload[258] << 16) | (payload[259] << 8) | payload[260];
                this.log(`Metadata: Scan #${sCount} | Bat: ${pctReal}% | Temp: ${tempC.toFixed(1)}°C`, 'log-sys');
            }
        } else if (cmd === 0x53) {
            // Manejo flexible para comando 0x53
            if (payload.length >= 257) {
                await this.processSpectrum(payload.slice(1, 257));
            } else {
                await this.processSpectrum(payload.slice(1));
            }
        } else if (cmd === 0x42 || cmd === this.CMD.BATTERY) {
            const pct = (payload.length > 1) ? payload[1] : (payload[0] || 0); 
            const valBat = document.getElementById('valBat');
            const labelBat = document.getElementById('labelBat');
            if (valBat) {
                valBat.textContent = pct + '';
                if (pct < 15) {
                    valBat.style.color = '#ef4444';
                    if (labelBat) {
                        labelBat.textContent = 'BAT. BAJA';
                        labelBat.style.color = '#ef4444';
                    }
                } else if (pct < 40) {
                    valBat.style.color = '#f97316';
                    if (labelBat) {
                        labelBat.textContent = 'MEDIO';
                        labelBat.style.color = '#f97316';
                    }
                } else {
                    valBat.style.color = '#4ade80';
                    if (labelBat) {
                        labelBat.textContent = 'OK';
                        labelBat.style.color = '#4ade80';
                    }
                }
            }
            this.log(`Nivel Batería (Cmd 0x42): ${pct}% | Payload: ${Array.from(payload).map(b => b.toString(16).padStart(2,'0')).join(' ')}`, 'log-warn');
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
        const isSample = this.scanTarget === 'sample';
        const scan = {
            id: isSample ? (this.sampleData.id || "N/A") : (Math.random() * 1000).toString(36),
            name: isSample ? (this.sampleData.name || "Muestra") : `Ref_${this.scanTarget}`,
            lot: isSample ? (this.sampleData.lot || "") : "",
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
                    <div class="h-name">${h.name} <span style="font-size:0.55rem; color:var(--dim)">[${h.id}]</span></div>
                    ${h.lot ? `<div class="h-lot" style="font-size:0.6rem; color:var(--orange)">Lote: ${h.lot}</div>` : ''}
                    ${h.prediction !== undefined ? `
                        <div class="h-res" style="margin-top:4px; padding:2px 6px; background:rgba(14,165,233,0.1); border-radius:4px; display:inline-block">
                            <span style="font-size:0.75rem; font-weight:900; color:#fff">${h.prediction.toFixed(2)}${h.unit || ''}</span>
                            <span style="font-size:0.55rem; color:rgba(255,255,255,0.4); margin-left:4px">${h.propName || ''}</span>
                            ${h.gh !== undefined ? `
                                <span style="font-size:0.6rem; margin-left:8px; font-weight:800; color:${h.gh > 3 ? '#fb923c' : '#4ade80'}">
                                    GH: ${h.gh.toFixed(2)}
                                </span>
                            ` : ''}
                        </div>
                    ` : ''}
                    <div class="h-date" style="margin-top:2px">${new Date(h.time).toLocaleTimeString()}</div>
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

        // --- ACTUALIZAR ETIQUETAS SEGÚN MODO ---
        const yTitle = this.showAbsorbance ? "Absorbancia (AU)" : "Intensidad (Counts)";
        if (this.chart.options.scales.y.title) {
            this.chart.options.scales.y.title.text = yTitle;
        }
        
        // También actualizamos el tooltip
        if (this.chart.options.plugins.tooltip) {
            const modeLabel = this.showAbsorbance ? "Abs:" : "ADC:";
            this.chart.options.plugins.tooltip.callbacks.label = (item: any) => ` ${modeLabel} ${item.raw}`;
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

    async takeAndSleepScan(withLamp: boolean) {
        this.log(`\n--- ESCANEO MECÁNICO (${this.HW_REPS} Reps) ---`, 'log-warn');
        this.setLed('ADC', true, 'on-orange');
        this.rxBuffer = [];
        this.inPacket = false;
        
        // Sincronizar reps
        const reps = this.HW_REPS;
        this.log(`Configurando integración: ${reps} reps...`, 'log-sys');
        const configPayload = this.createGenericSetUintCommandWithPasskey(53, reps);
        await this.sendCmdData(configPayload, 'config_hw_reps');
        await this.sleep(150);

        if (withLamp) {
            this.log('Encendiendo lámpara para estabilidad...', 'log-sys');
            await this.sendCmdData([0x21, 0x01, 0x00], 'lamp_on_pre');
            await this.sleep(3000); 
        }

        const presetId = withLamp ? 0x01 : 0x00;
        await this.sendCmdData([34, presetId, 0x00], 'scan_start_act');
        
        const waitTime = 2000; 
        this.log(`Integrando espectro (${waitTime}ms)...`, 'log-sys');
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

    async scanSample() {
        if (!this.connected) return alert("Conecta el MicroNIR primero.");
        if (!this.referenceData.dark || !this.referenceData.white) {
             return alert("Por favor toma la Oscuridad [1] y Blanco [2] antes de escanear la muestra.");
        }

        const data = await this.promptSampleData();
        if (!data) return; // Cancelado
        this.sampleData = data;

        this.log(`═══ ANALIZANDO: ${this.sampleData.name} (ID: ${this.sampleData.id}) ═══`, 'log-warn');
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

    async processSpectrum(raw: number[]) {
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
                    this.log(`✓ Punto ${this.multiScanBuffer.length}/4 capturado. Apagando lámpara y pausando 1.5s...`, 'log-warn');
                    await this.sendCmdData([0x21, 0x00, 0x00], 'lamp_off_intermediate');
                    
                    setTimeout(() => {
                        this.takeAndSleepScan_Auto(true);
                    }, 1500); 
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

            this.lastSpectrum = [...spectrum];
            this.pktCount++;
            const valPkt = document.getElementById('valPkt');
            if (valPkt) valPkt.textContent = `${spectrum.length} / ${this.pktCount}`;
            this.log(`Espectro Recibido (${this.HW_REPS} reps).`, 'log-sys');
            
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
                if (this.onCalibUpdate) {
                    this.onCalibUpdate({ 
                        dark: !!this.referenceData.dark, 
                        white: true 
                    });
                }
            } else if (target === 'dark') {
                this.referenceData.dark = [...spectrum];
                this.log("✓ Referencia 'DARK' guardada.", "log-default");
                if (this.onCalibUpdate) {
                    this.onCalibUpdate({ 
                        dark: true, 
                        white: !!this.referenceData.white 
                    });
                }
            } else if (target === 'sample') {
                this.log('✓ Análisis completado.', 'log-default');
                this.sendCmdData([0x21, 0x00, 0x00], 'lamp_off');

                // LÓGICA DE PREDICCIÓN CON MODELO JSON
                if (this.currentModel && this.referenceData.dark && this.referenceData.white) {
                    this.log('Iniciando motor de predicción...', 'log-sys');
                    const absorbanceForPrediction = spectrum.map((S, i) => {
                        const D = this.referenceData.dark![i] || 0;
                        const W = this.referenceData.white![i] || 1;
                        const R = Math.max((S - D) / (W - D <= 0 ? 1 : W - D), 0.00001);
                        return -Math.log10(R);
                    });
                    this.performPrediction(absorbanceForPrediction);
                }

                // Auto-descarga CSV eliminada por solicitud del usuario
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

        if (withLamp) {
            this.log('Encendiendo lámpara para punto...', 'log-sys');
            await this.sendCmdData([0x21, 0x01, 0x00], 'lamp_on_auto');
            await this.sleep(3000); 
        }

        const presetId = withLamp ? 0x01 : 0x00;
        await this.sendCmdData([34, presetId, 0x00], 'scan_start_act');
        
        const waitTime = 2000;
        this.log(`Integrando punto auto... (${waitTime}ms)`, 'log-sys');
        await this.sleep(waitTime); 
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
        
        const header = ["Sample Name", "Sample ID", "Lot/Info", ...wavelengths, "Serial Number", "User Name", "Temperature", "Integration Time (ms)", "Replicates"];
        
        const sampleName = this.sampleData.name || 'Muestra';
        const sampleId = this.sampleData.id || 'N/A';
        const lotInfo = this.sampleData.lot || 'N/A';

        // Extraer valores actuales de la UI
        const temp = document.getElementById('valTemp')?.textContent?.replace('°C', '') || "25.0";
        const exp = document.getElementById('valExp')?.textContent?.replace(' ms', '') || "12.5";
        
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

        const connectedName = this.bleDevice?.name || document.getElementById('devId')?.textContent || "M1-0000343";
        const cleanSerial = connectedName.replace('MicroNIR ', '').replace('MN ', '').replace('FTDI VID:', 'USB-').trim();

        const row = [
            sampleName,
            sampleId,
            lotInfo,
            ...dataRow,
            cleanSerial, 
            "Spectra-Nir User",
            temp,
            exp,
            "4" // Basado en el promediado multi-punto
        ];

        const csvContent = [header.join(','), row.join(',')].join('\n');
        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement("a");
        const url = URL.createObjectURL(blob);
        link.setAttribute("href", url);
        link.setAttribute("download", `Spectra-Nir_${sampleName}.csv`);
        link.style.visibility = 'hidden';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        
        this.log('✓ CSV exportado con formato compatible Viavi.', 'log-default');
    }

    promptSampleData(): Promise<{ id: string, name: string, lot: string } | null> {
        return new Promise(resolve => {
            const modal = document.getElementById('sampleModal');
            const inId = document.getElementById('sampleIdInput') as HTMLInputElement;
            const inName = document.getElementById('sampleNameInput') as HTMLInputElement;
            const inLot = document.getElementById('sampleLotInput') as HTMLInputElement;
            
            if (!modal || !inId || !inName || !inLot) { resolve(null); return; }
            
            // Limpiar valores previos
            inId.value = '';
            inName.value = '';
            inLot.value = '';
            
            modal.style.display = 'flex';
            setTimeout(() => inId.focus(), 80);

            const ok = () => {
                const id = inId.value.trim();
                const name = inName.value.trim();
                const lot = inLot.value.trim();
                
                if (!id || !name) {
                    alert("ID y Nombre son obligatorios");
                    return;
                }
                
                modal.style.display = 'none';
                resolve({ id, name, lot });
            };
            
            const cancel = () => { modal.style.display = 'none'; resolve(null); };

            const btnOk = document.getElementById('btnSampleOk');
            const btnCancel = document.getElementById('btnSampleCancel');
            if (btnOk) btnOk.onclick = ok;
            if (btnCancel) btnCancel.onclick = cancel;
            
            const keyHandler = (e: KeyboardEvent) => {
                if (e.key === 'Enter') ok();
                if (e.key === 'Escape') cancel();
            };
            inId.onkeydown = inName.onkeydown = inLot.onkeydown = keyHandler;
        });
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

    performPrediction(absorbance: number[]) {
        try {
            const m = this.currentModel;
            if (!m) return;
            if (this.onPredictionState) this.onPredictionState(true);
            
            this.log(`Iniciando motor de predicción para ${m.analyticalProperty}...`, 'log-sys');
            
            // Simular tiempo de procesamiento (2.5 segundos) para "sentir" el cálculo
            setTimeout(() => {
                try {
                    const result = predict(absorbance, m, (msg, type) => this.log(msg, type));

                    this.log(`Predicción final [${m.analyticalProperty}]: ${result.value.toFixed(4)}`, 'log-warn');
                    
                    // Actualizar el registro en el historial con el resultado de la predicción
                    if (this.history.length > 0 && this.scanTarget === 'sample') {
                        // El último escaneo de muestra está al inicio (index 0)
                        this.history[0].prediction = result.value;
                        this.history[0].gh = result.gh;
                        this.history[0].unit = result.unit;
                        this.history[0].propName = result.property;
                        localStorage.setItem('mn_history', JSON.stringify(this.history));
                        this.renderHistory();
                    }

                    if (this.onPrediction) this.onPrediction(result);
                    if (this.onPredictionState) this.onPredictionState(false);
                } catch (e: any) {
                    this.log(`Error en cálculo: ${e.message}`, 'log-err');
                    if (this.onPredictionState) this.onPredictionState(false);
                }
            }, 2500); // 2.5 segundos de "pensamiento"

        } catch (e: any) {
            this.log(`Error al iniciar predicción: ${e.message}`, 'log-err');
            if (this.onPredictionState) this.onPredictionState(false);
        }
    }

    sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
}

export default function App() {
    const appRef = useRef<MicroNIRApp | null>(null);
    const [calib, setCalib] = useState({ dark: false, white: false });
    const [models, setModels] = useState<PredictionModel[]>(() => {
        const saved = localStorage.getItem('mn_models');
        return saved ? JSON.parse(saved) : [];
    });
    const [selectedModelId, setSelectedModelId] = useState<string>(() => {
        return localStorage.getItem('mn_selected_model') || '';
    });
    const [predictionResult, setPredictionResult] = useState<PredictionResult | null>(null);
    const [isPredicting, setIsPredicting] = useState(false);

    useEffect(() => {
        localStorage.setItem('mn_models', JSON.stringify(models));
    }, [models]);

    useEffect(() => {
        localStorage.setItem('mn_selected_model', selectedModelId);
    }, [selectedModelId]);
    const [isSidebarOpen, setIsSidebarOpen] = useState(true);
    const [isUartUnlocked, setIsUartUnlocked] = useState(false);

    const unlockUart = () => {
        const pass = window.prompt("Ingrese clave de administrador para Monitor UART:");
        if (pass === 'UART1234') {
            setIsUartUnlocked(true);
        } else if (pass !== null) {
            alert("Clave incorrecta.");
        }
    };

    useEffect(() => {
        if (!appRef.current) {
            appRef.current = new MicroNIRApp();
            appRef.current.onCalibUpdate = (status) => {
                setCalib(status);
            };
            appRef.current.onPrediction = (res) => {
                setPredictionResult(res);
            };
            appRef.current.onPredictionState = (loading) => {
                setIsPredicting(loading);
            };
            appRef.current.initChart();
            appRef.current.setMode('ble');
            appRef.current.renderHistory();
        }
    }, []);

    useEffect(() => {
        const a = app();
        if (a) {
            const modelObj = models.find(m => m.id === selectedModelId);
            a.currentModel = modelObj ? modelObj.json : null;
        }
    }, [selectedModelId, models]);

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
                        <div className="logo-text">Spectra-<em>Nir</em></div>
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

            <div className={`main transition-all duration-300 relative ${isSidebarOpen ? 'sidebar-open' : 'sidebar-closed'}`} style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
                <aside className={`sidebar transition-all duration-300 overflow-y-auto ${isSidebarOpen ? 'w-80 translate-x-0' : 'w-0 -translate-x-full'}`} style={{ 
                    position: 'relative', 
                    zIndex: 20, 
                    background: 'rgba(15, 23, 42, 0.95)', 
                    backdropFilter: 'blur(20px)',
                    borderRight: isSidebarOpen ? '1px solid rgba(14, 165, 233, 0.2)' : 'none',
                    height: '100%',
                    flexShrink: 0
                }}>
                    <div style={{ width: '320px', padding: '20px', display: isSidebarOpen ? 'block' : 'none' }}>
                    <div style={{ 
                        border: '1px solid rgba(14, 165, 233, 0.3)', 
                        borderRadius: '12px', 
                        padding: '16px 12px', 
                        background: 'rgba(14, 25, 45, 0.4)', 
                        backdropFilter: 'blur(10px)',
                        marginBottom: '20px',
                        transition: 'all 0.3s ease',
                        position: 'relative'
                    }}>
                        <details style={{ cursor: 'pointer', position: 'relative', zIndex: 1 }} open>
                            <summary style={{ 
                                listStyle: 'none', 
                                display: 'flex', 
                                justifyContent: 'space-between', 
                                alignItems: 'center',
                                outline: 'none'
                             }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                    <div style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: '#4ade80', boxShadow: '0 0 12px rgba(74,222,128,0.8)' }}></div>
                                    <span style={{ fontSize: '0.75rem', fontWeight: '800', color: '#0ea5e9', letterSpacing: '0.05em', textTransform: 'uppercase' }}>DIAGNÓSTICO HW</span>
                                </div>
                                <Activity size={14} style={{ color: '#0ea5e9', opacity: 0.7 }} />
                            </summary>
                            
                            <div style={{ marginTop: '16px' }}>
                                <div className="led-row" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '6px' }}>
                                    <div className="led-badge" id="ledMCU" style={{ padding: '8px 2px', border: 'none', borderRadius: '8px', background: '#fff', color: '#0284c7', fontWeight: '900', fontSize: '0.55rem', boxShadow: '0 2px 4px rgba(0,0,0,0.1)' }}><div className="d"></div>MCU</div>
                                    <div className="led-badge" id="ledLAMP" style={{ padding: '8px 2px', border: 'none', borderRadius: '8px', background: '#fff', color: '#0284c7', fontWeight: '900', fontSize: '0.55rem', boxShadow: '0 2px 4px rgba(0,0,0,0.1)' }}><div className="d"></div>LAMP</div>
                                    <div className="led-badge" id="ledADC" style={{ padding: '8px 2px', border: 'none', borderRadius: '8px', background: '#fff', color: '#0284c7', fontWeight: '900', fontSize: '0.55rem', boxShadow: '0 2px 4px rgba(0,0,0,0.1)' }}><div className="d"></div>ADC</div>
                                    <div className="led-badge" id="ledDTR" style={{ padding: '8px 2px', border: 'none', borderRadius: '8px', background: '#fff', color: '#0284c7', fontWeight: '900', fontSize: '0.55rem', boxShadow: '0 2px 4px rgba(0,0,0,0.1)' }}><div className="d"></div>PWR</div>
                                </div>
                                <div className="signal-row" style={{ marginTop: '8px', display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '6px' }}>
                                    <div className="sig-badge" id="sigDTR" style={{ fontSize: '0.5rem', border: 'none', borderRadius: '5px', background: '#fff', color: '#0284c7', fontWeight: '900', padding: '4px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>DTR</div>
                                    <div className="sig-badge" id="sigRTS" style={{ fontSize: '0.5rem', border: 'none', borderRadius: '5px', background: '#fff', color: '#0284c7', fontWeight: '900', padding: '4px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>RTS</div>
                                    <div className="sig-badge" id="sigLINK" style={{ fontSize: '0.5rem', border: 'none', borderRadius: '5px', background: '#fff', color: '#0284c7', fontWeight: '900', padding: '4px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>LINK</div>
                                </div>
                                <div id="devId" style={{ fontSize: '0.55rem', color: 'rgba(14, 165, 233, 0.7)', textAlign: 'center', marginTop: '12px', fontFamily: 'var(--mono)', fontWeight: '700', letterSpacing: '0.05em' }}>—</div>
                            </div>
                        </details>
                    </div>

                    <div className="product-section" style={{ 
                        background: 'rgba(14, 25, 45, 0.4)', 
                        backdropFilter: 'blur(10px)',
                        border: '1px solid rgba(14, 165, 233, 0.3)',
                        borderRadius: '12px',
                        padding: '16px 12px',
                        position: 'relative',
                        marginBottom: '20px'
                    }}>
                        <div className="sec-label" style={{ color: '#0ea5e9', fontWeight: '800', border: 'none', fontSize: '0.65rem', textTransform: 'uppercase', marginBottom: '12px', padding: 0, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <span>PRODUCTO / MODELO</span>
                            <Database size={12} />
                        </div>
                        
                        <div style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
                            <select 
                                value={selectedModelId}
                                onChange={(e) => setSelectedModelId(e.target.value)}
                                style={{ 
                                    flex: 1,
                                    background: 'rgba(0,0,0,0.3)', 
                                    color: '#fff', 
                                    border: '1px solid rgba(14, 165, 233, 0.3)',
                                    borderRadius: '8px',
                                    padding: '8px',
                                    fontSize: '0.7rem',
                                    outline: 'none'
                                }}
                            >
                                <option value="">Sin Modelo (Solo espectro)</option>
                                {models.map(m => (
                                    <option key={m.id} value={m.id}>{m.product} - {m.name}</option>
                                ))}
                            </select>
                            <button 
                                onClick={() => document.getElementById('modelFileInput')?.click()}
                                style={{ 
                                    width: '35px', 
                                    height: '35px',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    background: 'rgba(14, 165, 233, 0.2)',
                                    border: '1px solid rgba(14, 165, 233, 0.4)',
                                    borderRadius: '8px',
                                    color: '#0ea5e9',
                                    cursor: 'pointer'
                                }}
                                title="Cargar nuevo modelo JSON"
                            >
                                <Plus size={16} />
                            </button>
                            <input 
                                id="modelFileInput" 
                                type="file" 
                                accept=".json" 
                                style={{ display: 'none' }} 
                                onChange={(e) => {
                                    const file = e.target.files?.[0];
                                    if (file) {
                                        const reader = new FileReader();
                                        reader.onload = (event) => {
                                            try {
                                                const json = JSON.parse(event.target?.result as string);
                                                if (!json.modelType || !json.analyticalProperty) {
                                                    throw new Error("El archivo no parece ser un modelo de predicción compatible.");
                                                }
                                                const newModel: PredictionModel = {
                                                    id: crypto.randomUUID(),
                                                    name: json.analyticalProperty,
                                                    product: file.name.replace('.json', '').toUpperCase(),
                                                    json: json
                                                };
                                                setModels(prev => [...prev, newModel]);
                                                setSelectedModelId(newModel.id);
                                                appRef.current?.log(`Modelo cargado: ${newModel.product} (${newModel.name})`, 'log-sys');
                                            } catch (err: any) {
                                                alert("Error al cargar modelo: " + err.message);
                                            }
                                        };
                                        reader.readAsText(file);
                                    }
                                }}
                            />
                        </div>

                        {selectedModelId && (
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <div style={{ fontSize: '0.6rem', color: 'rgba(255,255,255,0.4)', fontFamily: 'var(--mono)' }}>
                                    {models.find(m => m.id === selectedModelId)?.json.modelType} | {models.find(m => m.id === selectedModelId)?.json.nComponents} LVs
                                </div>
                                <button 
                                    onClick={() => {
                                        if (confirm("¿Eliminar este modelo?")) {
                                            setModels(prev => prev.filter(m => m.id !== selectedModelId));
                                            setSelectedModelId('');
                                        }
                                    }}
                                    style={{ background: 'transparent', border: 'none', color: 'rgba(239, 68, 68, 0.6)', cursor: 'pointer' }}
                                >
                                    <Trash2 size={12} />
                                </button>
                            </div>
                        )}
                    </div>

                    <div className="uuid-box" id="uuidBox" style={{ 
                        background: 'rgba(14, 25, 45, 0.4)', 
                        backdropFilter: 'blur(10px)',
                        border: '1px solid rgba(14, 165, 233, 0.3)',
                        borderRadius: '12px',
                        padding: '16px 12px',
                        position: 'relative',
                        marginBottom: '20px',
                        boxShadow: '0 4px 15px rgba(0,0,0,0.2)'
                    }}>
                        <div className="sec-label" style={{ color: '#0ea5e9', fontWeight: '800', border: 'none', fontSize: '0.65rem', textTransform: 'uppercase', marginBottom: '8px', padding: 0 }}>UUID SERVICIO BLE</div>
                        <input id="customUUIDInput" type="text"
                            onInput={(e: any) => { if (appRef.current) appRef.current.customServiceUUID = e.target.value.trim().toLowerCase() || null; }}
                            style={{ 
                                background: 'rgba(0,0,0,0.2)', 
                                color: '#fff', 
                                border: '1px solid rgba(14, 165, 233, 0.3)',
                                outline: 'none',
                                position: 'relative',
                                zIndex: 1,
                                width: '100%',
                                padding: '10px',
                                borderRadius: '8px',
                                fontSize: '0.65rem',
                                fontFamily: 'var(--mono)'
                             } as any}
                            placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                        />
                    </div>

                    <div id="bleSection" style={{ marginBottom: '20px' }}>
                        <button className="btn" onClick={() => app()?.connect()} style={{ 
                            background: 'rgba(14, 165, 233, 0.1)', 
                            color: '#0ea5e9', 
                            border: '1px solid rgba(14, 165, 233, 0.4)', 
                            borderRadius: '12px', 
                            padding: '14px',
                            boxShadow: '0 4px 15px rgba(0,0,0,0.2)',
                            fontWeight: '800',
                            backdropFilter: 'blur(10px)',
                            textTransform: 'uppercase',
                            letterSpacing: '0.08em',
                            fontSize: '0.7rem'
                        }}>
                            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{marginRight: '8px', filter: 'drop-shadow(0 0 5px rgba(14, 165, 233, 0.5))'}}><path d="M6.5 6.5l11 11M17.5 6.5l-11 11M12 2v20"/></svg>
                            CONECTAR MICRO-NIR
                        </button>

                        <button id="btnDisc" className="btn" onClick={() => window.location.reload()} style={{ 
                            marginTop: '12px',
                            background: 'transparent',
                            border: '1px solid rgba(239, 68, 68, 0.2)',
                            color: 'rgba(239, 68, 68, 0.6)',
                            borderRadius: '12px',
                            fontSize: '0.6rem',
                            fontWeight: '700',
                            width: '100%',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            padding: '10px',
                            textTransform: 'uppercase',
                            letterSpacing: '0.05em'
                        }}>
                            <PowerOff size={14} style={{marginRight: '8px', opacity: 0.5}}/>
                            Desconectar
                        </button>
                    </div>

                    <div className="history-section" style={{ 
                        background: 'rgba(14, 25, 45, 0.4)', 
                        backdropFilter: 'blur(10px)',
                        border: '1px solid rgba(14, 165, 233, 0.3)',
                        borderRadius: '12px',
                        position: 'relative',
                        overflow: 'hidden',
                        flex: 1,
                        display: 'flex',
                        flexDirection: 'column'
                    }}>
                        <div className="history-hdr" style={{ borderBottom: '1px solid rgba(14, 165, 233, 0.1)', position: 'relative', zIndex: 1, padding: '12px' }}>
                            <div className="sec-label" style={{ color: '#0ea5e9', fontWeight: '800', border: 'none', marginBottom: 0, fontSize: '0.65rem', textTransform: 'uppercase', padding: 0 }}>HISTORIAL</div>
                            <button className="h-clear" onClick={() => app()?.clearHistory()} style={{ color: 'rgba(239, 68, 68, 0.6)', fontWeight: '800', fontSize: '0.55rem', textTransform: 'uppercase' }}>Limpiar</button>
                        </div>
                        <div id="historyList" className="history-list" style={{ position: 'relative', zIndex: 1, flex: 1, overflowY: 'auto' }}>
                            <div className="dim-text" style={{fontSize:'.65rem', padding:'20px', color: 'rgba(14, 165, 233, 0.3)', fontWeight: '600' }}>Sin historial...</div>
                        </div>
                    </div>

                    <div className="console-wrap" style={{ 
                        display: 'flex', 
                        flexDirection: 'column', 
                        border: '1px solid rgba(14, 165, 233, 0.3)', 
                        borderRadius: '12px', 
                        overflow: 'hidden', 
                        marginTop: '15px',
                        background: 'rgba(14, 25, 45, 0.4)',
                        backdropFilter: 'blur(10px)'
                    }}>
                        <details style={{ width: '100%' }}>
                            <summary style={{ 
                                padding: '10px 12px', 
                                background: 'rgba(14, 165, 233, 0.1)', 
                                cursor: 'pointer', 
                                display: 'flex', 
                                justifyContent: 'space-between', 
                                alignItems: 'center',
                                userSelect: 'none',
                                listStyle: 'none',
                                borderBottom: '1px solid rgba(14, 165, 233, 0.3)'
                            }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                    <Activity size={12} style={{ color: '#0ea5e9' }} />
                                    <span style={{ fontSize: '0.65rem', fontWeight: '800', color: 'rgba(14, 165, 233, 0.9)', letterSpacing: '-0.01em' }}>CONSOLA / DEBUG</span>
                                </div>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                    <button className="chip-btn" id="btnPause" onClick={(e: any) => { 
                                        e.preventDefault();
                                        e.stopPropagation();
                                        const a = app(); 
                                        if (a) { 
                                            a.consolePaused = !a.consolePaused; 
                                            e.target.innerText = a.consolePaused ? '▶' : '⏸'; 
                                            e.target.style.color = a.consolePaused ? '#fff' : ''; 
                                        } 
                                    }} style={{ fontSize: '0.6rem', padding: '2px 6px', background: 'rgba(255,255,255,0.2)', color: '#fff', border: '1px solid rgba(255,255,255,0.3)' }}>⏸</button>
                                </div>
                            </summary>
                            <div style={{ height: '300px', borderTop: '1px solid var(--border)' }}>
                                <div className="console" id="console" style={{ fontSize: '11px', lineHeight: '1.3', height: '100%', background: 'var(--bg)' }}>
                                    <div className="log-sys">{'>'} MicroNIR v6.0 Ready...</div>
                                </div>
                            </div>
                        </details>
                    </div>
                </div>
            </aside>

                {/* Sidebar Toggle Button (Tab) */}
                <button 
                    onClick={() => {
                        setIsSidebarOpen(!isSidebarOpen);
                        setTimeout(() => app()?.chart?.resize(), 310);
                    }}
                    style={{
                        position: 'absolute',
                        left: isSidebarOpen ? '320px' : '0px',
                        top: '50%',
                        transform: 'translateY(-50%)',
                        zIndex: 30,
                        width: '24px',
                        height: '60px',
                        background: 'rgba(14, 25, 45, 0.9)',
                        border: '1px solid rgba(14, 165, 233, 0.3)',
                        borderLeft: 'none',
                        borderRadius: '0 8px 8px 0',
                        color: '#0ea5e9',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        transition: 'left 0.3s ease, background 0.2s',
                        backdropFilter: 'blur(10px)',
                        boxShadow: '4px 0 10px rgba(0,0,0,0.3)'
                    }}
                    className="hover:bg-cyan-500/10"
                >
                    <div style={{ transform: isSidebarOpen ? 'rotate(0deg)' : 'rotate(180deg)', transition: 'transform 0.3s' }}>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="15 18 9 12 15 6"></polyline>
                        </svg>
                    </div>
                </button>

                <main className="content transition-all duration-300" style={{ 
                    flex: 1, 
                    overflowY: 'auto', 
                    padding: '24px',
                    marginLeft: 0
                }}>
                    <div className="metrics-row" style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '1rem', marginBottom: '1.5rem' }}>
                        {/* CARD 1: CANAL DE DATOS */}
                        <div className="metric-card" style={{ background: 'rgba(14, 25, 45, 0.4)', backdropFilter: 'blur(10px)', border: '1px solid rgba(14, 165, 233, 0.3)', borderRadius: '12px', padding: '1.25rem', boxShadow: '0 4px 15px rgba(0,0,0,0.2)', position: 'relative', overflow: 'hidden', display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
                            <div style={{ position: 'absolute', bottom: '0', left: '0', width: '100%', height: '50%', background: 'linear-gradient(to top, rgba(14, 165, 233, 0.1), transparent)', zIndex: 0 }}></div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', position: 'relative', zIndex: 1 }}>
                                <span style={{ fontSize: '0.65rem', textTransform: 'uppercase', letterSpacing: '0.12em', color: '#0ea5e9', fontWeight: '800' }}>Canal de Datos</span>
                                <Cpu size={20} style={{ color: '#0ea5e9', opacity: 1, filter: 'drop-shadow(0 0 8px rgba(14, 165, 233, 0.6))' }} />
                            </div>
                            <div style={{ position: 'relative', zIndex: 1, marginTop: '8px' }}>
                                <div style={{ display: 'flex', alignItems: 'baseline', gap: '4px' }}>
                                    <span id="valMode" style={{ fontSize: '1.5rem', fontWeight: '800', color: '#ffffff', fontFamily: 'var(--mono)', textShadow: '0 2px 10px rgba(0,0,0,0.5)' }}>—</span>
                                </div>
                            </div>
                            <div style={{ position: 'absolute', bottom: '0', left: '0', width: '100%', height: '4px', background: 'rgba(14, 165, 233, 0.3)', opacity: 0.6 }}></div>
                        </div>

                        {/* CARD 2: INTEGRACIÓN */}
                        <div className="metric-card" style={{ background: 'rgba(14, 25, 45, 0.4)', backdropFilter: 'blur(10px)', border: '1px solid rgba(14, 165, 233, 0.3)', borderRadius: '12px', padding: '1.25rem', boxShadow: '0 4px 15px rgba(0,0,0,0.2)', position: 'relative', overflow: 'hidden', display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
                            <div style={{ position: 'absolute', bottom: '0', left: '0', width: '100%', height: '50%', background: 'linear-gradient(to top, rgba(14, 165, 233, 0.1), transparent)', zIndex: 0 }}></div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', position: 'relative', zIndex: 1 }}>
                                <span style={{ fontSize: '0.65rem', textTransform: 'uppercase', letterSpacing: '0.12em', color: '#0ea5e9', fontWeight: '800' }}>Integración</span>
                                <Clock size={20} style={{ color: '#0ea5e9', opacity: 1, filter: 'drop-shadow(0 0 8px rgba(14, 165, 233, 0.6))' }} />
                            </div>
                            <div style={{ position: 'relative', zIndex: 1, marginTop: '8px' }}>
                                <div style={{ display: 'flex', alignItems: 'baseline', gap: '4px' }}>
                                    <span id="valExp" style={{ fontSize: '1.5rem', fontWeight: '800', color: '#ffffff', fontFamily: 'var(--mono)', textShadow: '0 2px 10px rgba(0,0,0,0.5)' }}>—</span>
                                    <span style={{ fontSize: '0.7rem', color: '#0ea5e9', fontWeight: '700' }}>ms</span>
                                </div>
                            </div>
                            <div style={{ position: 'absolute', bottom: '0', left: '0', width: '100%', height: '4px', background: 'rgba(14, 165, 233, 0.3)', opacity: 0.6 }}></div>
                        </div>

                        {/* CARD 3: TEMPERATURA */}
                        <div className="metric-card" style={{ background: 'rgba(14, 25, 45, 0.4)', backdropFilter: 'blur(10px)', border: '1px solid rgba(14, 165, 233, 0.3)', borderRadius: '12px', padding: '1.25rem', boxShadow: '0 4px 15px rgba(0,0,0,0.2)', position: 'relative', overflow: 'hidden', display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
                            <div style={{ position: 'absolute', bottom: '0', left: '0', width: '100%', height: '50%', background: 'linear-gradient(to top, rgba(14, 165, 233, 0.1), transparent)', zIndex: 0 }}></div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', position: 'relative', zIndex: 1 }}>
                                <span style={{ fontSize: '0.65rem', textTransform: 'uppercase', letterSpacing: '0.12em', color: '#0ea5e9', fontWeight: '800' }}>Temperatura</span>
                                <Thermometer size={20} style={{ color: '#0ea5e9', opacity: 1, filter: 'drop-shadow(0 0 8px rgba(14, 165, 233, 0.6))' }} />
                            </div>
                            <div style={{ position: 'relative', zIndex: 1, marginTop: '8px' }}>
                                <div style={{ display: 'flex', alignItems: 'baseline', gap: '4px' }}>
                                    <span id="valTemp" style={{ fontSize: '1.5rem', fontWeight: '800', color: '#ffffff', fontFamily: 'var(--mono)', textShadow: '0 2px 10px rgba(0,0,0,0.5)' }}>—</span>
                                    <span style={{ fontSize: '0.7rem', color: '#0ea5e9', fontWeight: '700' }}>°C</span>
                                </div>
                            </div>
                            <div style={{ position: 'absolute', bottom: '0', left: '0', width: '100%', height: '4px', background: 'rgba(14, 165, 233, 0.3)', opacity: 0.6 }}></div>
                        </div>

                        {/* CARD 4: BATERÍA */}
                        <div className="metric-card" style={{ background: 'rgba(14, 25, 45, 0.4)', backdropFilter: 'blur(10px)', border: '1px solid rgba(14, 165, 233, 0.3)', borderRadius: '12px', padding: '1.25rem', boxShadow: '0 4px 15px rgba(0,0,0,0.2)', position: 'relative', overflow: 'hidden', display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
                            <div style={{ position: 'absolute', bottom: '0', left: '0', width: '100%', height: '50%', background: 'linear-gradient(to top, rgba(14, 165, 233, 0.1), transparent)', zIndex: 0 }}></div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', position: 'relative', zIndex: 1 }}>
                                <span style={{ fontSize: '0.65rem', textTransform: 'uppercase', letterSpacing: '0.12em', color: '#0ea5e9', fontWeight: '800' }}>Nivel Batería</span>
                                <Battery size={20} style={{ color: '#0ea5e9', opacity: 1, filter: 'drop-shadow(0 0 8px rgba(14, 165, 233, 0.6))' }} />
                            </div>
                            <div style={{ position: 'relative', zIndex: 1, marginTop: '8px' }}>
                                <div style={{ display: 'flex', alignItems: 'baseline', gap: '4px' }}>
                                    <span id="valBat" style={{ fontSize: '1.5rem', fontWeight: '800', fontFamily: 'var(--mono)', textShadow: '0 2px 10px rgba(0,0,0,0.5)' }}>—</span>
                                    <span id="labelBat" style={{ fontSize: '0.6rem', fontWeight: '800', marginLeft: '4px' }}></span>
                                    <span style={{ fontSize: '0.7rem', color: '#0ea5e9', fontWeight: '700' }}>%</span>
                                </div>
                            </div>
                            <div style={{ position: 'absolute', bottom: '0', left: '0', width: '100%', height: '4px', background: 'rgba(14, 165, 233, 0.3)', opacity: 0.6 }}></div>
                        </div>

                        {/* CARD 5: SINCRONIZACIÓN */}
                        <div className="metric-card" style={{ background: 'rgba(14, 25, 45, 0.4)', backdropFilter: 'blur(10px)', border: '1px solid rgba(14, 165, 233, 0.3)', borderRadius: '12px', padding: '1.25rem', boxShadow: '0 4px 15px rgba(0,0,0,0.2)', position: 'relative', overflow: 'hidden', display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
                            <div style={{ position: 'absolute', bottom: '0', left: '0', width: '100%', height: '50%', background: 'linear-gradient(to top, rgba(14, 165, 233, 0.1), transparent)', zIndex: 0 }}></div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', position: 'relative', zIndex: 1 }}>
                                <span style={{ fontSize: '0.65rem', textTransform: 'uppercase', letterSpacing: '0.12em', color: '#0ea5e9', fontWeight: '800' }}>Sincronización</span>
                                <Activity size={20} style={{ color: '#0ea5e9', opacity: 1, filter: 'drop-shadow(0 0 8px rgba(14, 165, 233, 0.6))' }} />
                            </div>
                            <div style={{ position: 'relative', zIndex: 1, marginTop: '8px' }}>
                                <div style={{ display: 'flex', alignItems: 'baseline', gap: '4px' }}>
                                    <span id="valPkt" style={{ fontSize: '1.55rem', fontWeight: '800', color: '#ffffff', fontFamily: 'var(--mono)', textShadow: '0 2px 10px rgba(0,0,0,0.5)' }}>— / —</span>
                                </div>
                            </div>
                            <div style={{ position: 'absolute', bottom: '0', left: '0', width: '100%', height: '4px', background: 'rgba(14, 165, 233, 0.3)', opacity: 0.6 }}></div>
                        </div>
                    </div>

                    <div id="progressContainer" style={{display:'none', background:'rgba(0,184,217,0.05)', borderRadius:'6px', padding:'12px', border:'1px solid rgba(0,184,217,0.1)', marginBottom:'15px'}}>
                        <div style={{display:'flex', justifyContent:'space-between', marginBottom:'10px'}}>
                            <span className="label" style={{fontSize:'0.75rem', color:'var(--primary)', fontFamily:'Share Tech Mono', fontWeight:'bold'}}>PROGRESO DE INTEGRACIÓN</span>
                            <span id="progressText" className="val" style={{fontSize:'0.75rem', color:'var(--primary)', fontFamily:'Share Tech Mono'}}>0%</span>
                        </div>
                        <div style={{width:'100%', height:'8px', background:'rgba(255,255,255,0.05)', borderRadius:'4px', overflow:'hidden', border:'1px solid rgba(255,255,255,0.05)'}}>
                            <div id="progressBar" style={{width:'0%', height:'100%', background:'var(--primary)', transition:'width 0.15s ease'}}></div>
                        </div>
                    </div>

                    <div className="calibration-wizard" style={{ 
                        display: 'flex', 
                        gap: '12px', 
                        background: 'linear-gradient(135deg, #112240 0%, #0a192f 100%)', 
                        padding: '20px', 
                        borderRadius: '16px', 
                        border: '1px solid #1e293b', 
                        boxShadow: '0 10px 25px -3px rgba(0,0,0,0.4)', 
                        marginBottom: '20px', 
                        alignItems: 'stretch' 
                    }}>
                        <div style={{ 
                            display: 'flex', 
                            flexDirection: 'column', 
                            justifyContent: 'center',
                            paddingRight: '20px',
                            borderRight: '2px solid #1e293b',
                            marginRight: '10px'
                        }}>
                             <div style={{ color: '#94a3b8', fontSize: '0.65rem', fontWeight: '800', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Protocolo de</div>
                             <div style={{ color: '#fff', fontSize: '0.9rem', fontWeight: '900', letterSpacing: '-0.02em' }}>CALIBRACIÓN</div>
                        </div>
                        
                        <button id="btnDark" className="btn" onClick={() => app()?.setDarkReference()} style={{ 
                            flex: 1, 
                            backgroundColor: calib.dark ? 'rgba(56,189,248,0.1)' : 'rgba(255,255,255,0.03)', 
                            color: calib.dark ? '#38bdf8' : '#94a3b8', 
                            border: calib.dark ? '2px solid #38bdf8' : '1px solid #334155', 
                            borderRadius: '12px',
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: 'center',
                            justifyContent: 'center',
                            padding: '12px',
                            height: 'auto',
                            transition: 'all 0.2s',
                            boxShadow: calib.dark ? '0 0 20px rgba(56,189,248,0.2)' : 'none'
                        }}>
                            <Moon size={18} style={{ marginBottom: '6px', opacity: 0.8 }} />
                            <span style={{ fontSize: '0.6rem', opacity: calib.dark ? 0.8 : 0.5, marginBottom: '2px' }}>
                                {calib.dark ? '✓ COMPLETADO' : 'PASO 01'}
                            </span>
                            <span style={{ fontSize: '0.85rem', fontWeight: '800' }}>OSCURIDAD</span>
                        </button>
                        
                        <button id="btnWhite" className="btn" onClick={() => app()?.setWhiteReference()} style={{ 
                            flex: 1, 
                            backgroundColor: calib.white ? 'rgba(56,189,248,0.1)' : 'rgba(255,255,255,0.03)', 
                            color: calib.white ? '#38bdf8' : '#94a3b8', 
                            border: calib.white ? '2px solid #38bdf8' : '1px solid #334155', 
                            borderRadius: '12px',
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: 'center',
                            justifyContent: 'center',
                            padding: '12px',
                            height: 'auto',
                            transition: 'all 0.2s',
                            boxShadow: calib.white ? '0 0 20px rgba(56,189,248,0.2)' : 'none'
                        }}>
                            <Sun size={18} style={{ marginBottom: '6px', opacity: 0.8 }} />
                            <span style={{ fontSize: '0.6rem', opacity: calib.white ? 0.8 : 0.5, marginBottom: '2px' }}>
                                {calib.white ? '✓ COMPLETADO' : 'PASO 02'}
                            </span>
                            <span style={{ fontSize: '0.85rem', fontWeight: '800' }}>BLANCO REFE.</span>
                        </button>
                        
                        <button id="btnAbs" className="btn" 
                            onClick={() => {
                                setPredictionResult(null);
                                app()?.scanSample();
                            }} 
                            style={{ 
                            flex: 1.5, 
                            background: (calib.dark && calib.white) 
                                ? 'linear-gradient(135deg, #10b981 0%, #059669 100%)' 
                                : '#1e293b', 
                            color: (calib.dark && calib.white) ? '#fff' : '#475569', 
                            border: 'none', 
                            borderRadius: '12px',
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: 'center',
                            justifyContent: 'center',
                            padding: '12px',
                            height: 'auto',
                            boxShadow: (calib.dark && calib.white) ? '0 10px 20px -3px rgba(16,185,129,0.4)' : 'none',
                            transition: 'all 0.2s',
                            cursor: (calib.dark && calib.white) ? 'pointer' : 'not-allowed',
                            opacity: (calib.dark && calib.white) ? 1 : 0.7,
                            position: 'relative',
                            overflow: 'hidden'
                        }}>
                            <div style={{
                                position: 'absolute',
                                top: 0, left: 0, width: '100%', height: '100%',
                                background: 'linear-gradient(45deg, transparent, rgba(255,255,255,0.1), transparent)',
                                transform: 'translateX(-100%)',
                                animation: (calib.dark && calib.white) ? 'shimmer 3s infinite' : 'none'
                            }}></div>
                            <Zap size={20} style={{ marginBottom: '6px', filter: 'drop-shadow(0 0 5px rgba(255,255,255,0.5))' }} />
                            <span style={{ fontSize: '0.6rem', opacity: 0.8, marginBottom: '2px', fontWeight: '800' }}>PASO 03</span>
                            <span style={{ fontSize: '1rem', fontWeight: '900', letterSpacing: '0.02em' }}>ANALIZAR MUESTRA</span>
                        </button>
                    </div>



                    <div className="dashboard-main" style={{ display: 'flex', gap: '20px', minHeight: '500px', marginBottom: '20px' }}>
                        {/* LADO IZQUIERDO: ESPECTRO */}
                        <div className="chart-panel" style={{ flex: 7, marginBottom: 0 }}>
                            <div className="chart-hdr">
                                <span className="chart-title">ESPECTRO NIR — 128 PÍXELES InGaAs</span>
                                <div className="chart-btns">
                                    <button className="chip-btn" onClick={() => app()?.toggleAbsorbance()}>Adc / Absorbancia</button>
                                    <button className="chip-btn" onClick={() => app()?.clearChart()}>Limpiar</button>
                                    <button className="chip-btn hover:bg-green-500/10" onClick={() => app()?.exportCSV()} style={{ 
                                        background: 'transparent', 
                                        border: '1px solid rgba(34,197,94,0.6)', 
                                        color: '#4ade80',
                                        transition: 'all 0.2s'
                                    }}>Exportar CSV</button>
                                </div>
                            </div>
                            <div className="chart-canvas-wrap">
                                <canvas id="nirChart"></canvas>
                            </div>
                        </div>

                        {/* LADO DERECHO: DASHBOARD DE RESULTADOS */}
                        <div className="results-panel" style={{ 
                            flex: 3, 
                            background: 'rgba(15, 23, 42, 0.4)', 
                            border: '1px solid rgba(14, 165, 233, 0.3)', 
                            borderRadius: '16px',
                            display: 'flex',
                            flexDirection: 'column',
                            padding: '20px',
                            boxShadow: '0 4px 30px rgba(0,0,0,0.4)',
                            backdropFilter: 'blur(10px)'
                        }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '20px', paddingBottom: '12px', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                                <Zap size={18} style={{ color: '#0ea5e9' }} />
                                <span style={{ fontWeight: '800', fontSize: '0.7rem', color: '#fff', letterSpacing: '0.05em' }}>PANTALLA DE RESULTADOS</span>
                            </div>

                            {!selectedModelId ? (
                                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center' }}>
                                    <Database size={48} style={{ color: 'rgba(14, 165, 233, 0.1)', marginBottom: '15px' }} />
                                    <p style={{ color: 'rgba(255,255,255,0.3)', fontSize: '0.75rem', lineHeight: '1.4' }}>
                                        No hay un modelo activo.<br/>
                                        Cargue un JSON en la barra lateral para habilitar predicciones.
                                    </p>
                                </div>
                            ) : (
                                <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
                                    {/* Cabecera del modelo */}
                                    <div style={{ background: 'rgba(0,0,0,0.2)', padding: '15px', borderRadius: '12px', marginBottom: '20px' }}>
                                        <div style={{ fontSize: '0.6rem', color: '#38bdf8', fontWeight: '800', marginBottom: '4px' }}>PRODUCTO</div>
                                        <div style={{ fontSize: '1.1rem', fontWeight: '900', color: '#fff' }}>{models.find(m => m.id === selectedModelId)?.product}</div>
                                    </div>

                                    {/* Área de valor principal */}
                                    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center' }}>
                                        {isPredicting ? (
                                            <div style={{ textAlign: 'center' }}>
                                                <div className="processing-loader" style={{ 
                                                    width: '60px', 
                                                    height: '60px', 
                                                    border: '3px solid rgba(14, 165, 233, 0.1)', 
                                                    borderTopColor: '#0ea5e9',
                                                    borderRadius: '50%',
                                                    animation: 'spin 1s linear infinite',
                                                    margin: '0 auto 15px'
                                                }}></div>
                                                <div style={{ fontSize: '0.65rem', color: '#0ea5e9', fontWeight: '700', letterSpacing: '0.1em' }}>ANALIZANDO...</div>
                                                <div style={{ fontSize: '0.6rem', color: 'rgba(255,255,255,0.4)', marginTop: '4px' }}>Procesando Quimiometría PLS</div>
                                            </div>
                                        ) : predictionResult ? (
                                            <div style={{ width: '100%', textAlign: 'center' }}>
                                                <div style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.4)', marginBottom: '10px' }}>{predictionResult.property.toUpperCase()}</div>
                                                <div style={{ 
                                                    fontSize: '4.5rem', 
                                                    fontWeight: '950', 
                                                    color: '#fff', 
                                                    lineHeight: '1',
                                                    textShadow: '0 0 30px rgba(14, 165, 233, 0.6), 0 0 60px rgba(14, 165, 233, 0.2)',
                                                    filter: 'drop-shadow(0 0 10px rgba(255,255,255,0.2))'
                                                }}>
                                                    {predictionResult.value.toFixed(2)}
                                                </div>
                                                <div style={{ fontSize: '1.2rem', color: '#38bdf8', fontWeight: '800', marginTop: '5px' }}>{predictionResult.unit}</div>
                                                
                                                {/* Indicador de GH (Distancia Mahalanobis) */}
                                                {predictionResult.gh !== undefined && (
                                                    <div style={{ 
                                                        marginTop: '15px', 
                                                        padding: '4px 10px', 
                                                        background: predictionResult.gh > 3 ? 'rgba(249, 115, 22, 0.1)' : 'rgba(16, 185, 129, 0.1)', 
                                                        borderRadius: '20px',
                                                        display: 'inline-flex',
                                                        alignItems: 'center',
                                                        gap: '6px',
                                                        border: `1px solid ${predictionResult.gh > 3 ? 'rgba(249, 115, 22, 0.3)' : 'rgba(16, 185, 129, 0.3)'}`
                                                    }}>
                                                        <span style={{ fontSize: '0.6rem', color: 'rgba(255,255,255,0.5)', fontWeight: '700' }}>DISTANCIA GH:</span>
                                                        <span style={{ 
                                                            fontSize: '0.75rem', 
                                                            fontWeight: '900', 
                                                            color: predictionResult.gh > 3 ? '#fb923c' : '#4ade80' 
                                                        }}>
                                                            {predictionResult.gh.toFixed(2)}
                                                        </span>
                                                    </div>
                                                )}
                                            </div>
                                        ) : (
                                            <div style={{ textAlign: 'center' }}>
                                                <div style={{ 
                                                    width: '80px', 
                                                    height: '80px', 
                                                    border: '2px dashed rgba(56, 189, 248, 0.2)', 
                                                    borderRadius: '50%',
                                                    display: 'flex',
                                                    alignItems: 'center',
                                                    justifyContent: 'center',
                                                    margin: '0 auto 20px'
                                                }}>
                                                    <span className="scan-anim" style={{ width: '40px', height: '2px', background: '#38bdf8', borderRadius: '2px', animation: 'scanLine 2s infinite' }}></span>
                                                </div>
                                                <span style={{ fontSize: '0.7rem', color: 'rgba(255,255,255,0.4)', fontWeight: '600' }}>ESPERANDO ESCANEO...</span>
                                            </div>
                                        )}
                                    </div>

                                    {/* Info técnica pie */}
                                    <div style={{ marginTop: 'auto', background: 'rgba(255,255,255,0.03)', padding: '12px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.05)' }}>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                                            <span style={{ fontSize: '0.6rem', color: 'rgba(255,255,255,0.3)' }}>ALGORITMO</span>
                                            <span style={{ fontSize: '0.6rem', color: '#fff', fontWeight: '700' }}>PLS REGRESSION</span>
                                        </div>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                                            <span style={{ fontSize: '0.6rem', color: 'rgba(255,255,255,0.3)' }}>ESTADO MUESTRA</span>
                                            <span style={{ 
                                                fontSize: '0.6rem', 
                                                color: (predictionResult?.gh && predictionResult.gh > 3) ? '#fb923c' : '#4ade80', 
                                                fontWeight: '800' 
                                            }}>
                                                {(predictionResult?.gh && predictionResult.gh > 3) ? 'FUERA DE RANGO / OUTLIER' : 'DENTRO DE RANGO'}
                                            </span>
                                        </div>
                                        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                                            <span style={{ fontSize: '0.6rem', color: 'rgba(255,255,255,0.3)' }}>FECHA MODELO</span>
                                            <span style={{ fontSize: '0.6rem', color: '#fff', fontWeight: '700' }}>{new Date(models.find(m => m.id === selectedModelId)?.json.date).toLocaleDateString()}</span>
                                        </div>
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>
                </main>
            </div>

            <div className="modal-overlay" id="sampleModal" style={{ backgroundColor: 'rgba(2, 6, 23, 0.85)', backdropFilter: 'blur(4px)' }}>
                <div className="modal" style={{ maxWidth: '400px', backgroundColor: '#0f172a', border: '1px solid #1e293b', boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.5)' }}>
                    <h3 style={{ color: '#38bdf8' }}>Información de la Muestra</h3>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '15px', marginTop: '10px' }}>
                        <div style={{ textAlign: 'left' }}>
                            <label style={{ fontSize: '0.7rem', color: '#94a3b8', display: 'block', marginBottom: '4px' }}>ID Muestra (*)</label>
                            <input id="sampleIdInput" type="text" placeholder="Ej: 001" style={{ width: '100%', background: '#1e293b', border: '1px solid #334155', color: '#f1f5f9', borderRadius: '4px', padding: '8px', outline: 'none' }} />
                        </div>
                        <div style={{ textAlign: 'left' }}>
                            <label style={{ fontSize: '0.7rem', color: '#94a3b8', display: 'block', marginBottom: '4px' }}>Nombre Muestra (*)</label>
                            <input id="sampleNameInput" type="text" placeholder="Ej: Harina de Soja" style={{ width: '100%', background: '#1e293b', border: '1px solid #334155', color: '#f1f5f9', borderRadius: '4px', padding: '8px', outline: 'none' }} />
                        </div>
                        <div style={{ textAlign: 'left' }}>
                            <label style={{ fontSize: '0.7rem', color: '#94a3b8', display: 'block', marginBottom: '4px' }}>Lote y/o inf</label>
                            <input id="sampleLotInput" type="text" placeholder="Ej: Lote 2024-A" style={{ width: '100%', background: '#1e293b', border: '1px solid #334155', color: '#f1f5f9', borderRadius: '4px', padding: '8px', outline: 'none' }} />
                        </div>
                    </div>
                    <div className="modal-btns" style={{ marginTop: '20px' }}>
                        <button className="btn" id="btnSampleOk" style={{ background: 'linear-gradient(135deg, #38bdf8 0%, #0284c7 100%)', color: '#fff' }}>Iniciar Análisis</button>
                        <button className="btn btn-ghost-red" id="btnSampleCancel">Cancelar</button>
                    </div>
                </div>
            </div>

            <div className="modal-overlay" id="uuidModal" style={{ backgroundColor: 'rgba(2, 6, 23, 0.85)', backdropFilter: 'blur(4px)' }}>
                <div className="modal" style={{ backgroundColor: '#0f172a', border: '1px solid #1e293b' }}>
                    <h3 style={{ color: '#38bdf8' }}>UUID de Servicio Requerido</h3>
                    <p style={{ color: '#94a3b8' }}>
                        El descubrimiento automático no encontró servicios accesibles.<br/>
                        Usa <span style={{ color: 'var(--warn)' }}>nRF Connect</span> o <span style={{ color: 'var(--warn)' }}>LightBlue</span> para obtener
                        el UUID del servicio UART del MicroNIR y pégalo aquí.
                    </p>
                    <input id="uuidModalInput" type="text" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" style={{ background: '#1e293b', border: '1px solid #334155', color: '#f1f5f9', outline: 'none' }}/>
                    <div className="modal-btns">
                        <button className="btn" id="btnUUIDOk" style={{ background: 'linear-gradient(135deg, #38bdf8 0%, #0284c7 100%)', color: '#fff' }}>Confirmar y Reconectar</button>
                        <button className="btn btn-ghost-red" id="btnUUIDCancel">Cancelar</button>
                    </div>
                </div>
            </div>
        </>
    );
}
