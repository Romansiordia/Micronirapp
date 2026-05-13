/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useRef, useState } from 'react';
import { Chart, registerables } from 'chart.js';
import { Cpu, Clock, Thermometer, Battery, Activity, Moon, Sun, Zap, Lock, Unlock, PowerOff, Database, FileJson, ChevronDown, Plus, Trash2, Printer, Settings, BarChart3, ShieldAlert, LayoutDashboard, Search, Link as LinkIcon, RefreshCw, Bluetooth, Usb, Cloud, LayoutList, Wheat, Sprout, Leaf, Flower2, FlaskConical, Beef, Fish, Package } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { PredictionModel, PredictionResult, ModelJSON } from './types';
import { predict } from './services/chemometrics';
import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";

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
    history: { 
        id: string; 
        name: string; 
        lot?: string; 
        data: number[]; 
        absData?: number[];
        time: number;
        prediction?: number;
        gh?: number;
        unit?: string;
        propName?: string;
        allPredictions?: any[];
    }[];
    onHistoryView?: (item: any | null) => void;
    onLog?: (logs: any[]) => void;
    logs: any[] = [];
    sessionHistory: any[] = [];
    biasSettings: Record<string, Record<string, { bias: number, slope: number }>> = {};
    sampleData: { id: string; name: string; lot: string };
    onPredictions?: (results: PredictionResult[]) => void;
    onPredictionState?: (loading: boolean) => void;
    onScanState?: (isScanning: boolean) => void;
    onAbsorbanceToggle?: (active: boolean) => void;
    onHistoryChange?: (history: any[]) => void;
    onStatusUpdate?: (status: {
        mode: string;
        exp: number;
        temp: number;
        batt: string;
        pkt: string;
    }) => void;
    onHwUpdate?: (hw: Record<string, boolean>) => void;
    currentModels: PredictionModel[] = [];
    customServiceUUID: string | null = null;

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
        this.biasSettings = JSON.parse(localStorage.getItem('mn_bias_settings') || '{}');
  }

    initChart() {
        const canvas = document.getElementById('nirChart') as HTMLCanvasElement;
        if (!canvas) {
            this.log("⚠️ Error: No se encontró 'nirChart' en el DOM", "log-err");
            return;
        }

        const ctx = canvas.getContext('2d');
        if (!ctx) {
            this.log("⚠️ Error: No se pudo obtener el contexto 2D del canvas", "log-err");
            return;
        }

        if (this.chart) {
            this.chart.destroy();
            this.chart = null;
        }

        this.log(`Iniciando Chart.js sobre lienzo ${canvas.clientWidth}x${canvas.clientHeight}...`, 'log-sys');

        const labels = Array.from({length: 125}, (_, i) => (908.1 + i * 6.19435).toFixed(1));

        try {
            this.chart = new Chart(ctx, {
                type: 'line',
                data: {
                    labels,
                    datasets: [
                        {
                            label: 'Espectro',
                            data: new Array(125).fill(0),
                            borderColor: '#38bdf8',
                            borderWidth: 3,
                            pointRadius: 0,
                            fill: false,
                            tension: 0.2,
                            order: 1
                        }
                    ]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    animation: false, // Desactivar animaciones para máximo rendimiento
                    devicePixelRatio: window.devicePixelRatio || 1,
                    layout: {
                        padding: { left: 10, right: 20, top: 20, bottom: 10 }
                    },
                    scales: {
                        y: {
                            display: true,
                            min: 0,
                            suggestedMax: 65535,
                            grid: { 
                                display: true,
                                color: 'rgba(255, 255, 255, 0.05)',
                            },
                            ticks: { 
                                display: true,
                                color: '#94a3b8', 
                                font: { family: 'Inter', size: 9 },
                            },
                            border: { display: true, color: 'rgba(56, 189, 248, 0.3)' },
                            title: { 
                                display: true, 
                                text: 'Intensidad / ADC', 
                                color: '#38bdf8', 
                                font: { size: 10, family: 'Inter', weight: 800 } 
                            }
                        },
                        x: {
                            display: true,
                            grid: { 
                                display: true,
                                color: 'rgba(255, 255, 255, 0.05)',
                            },
                            ticks: { 
                                display: true,
                                color: '#94a3b8', 
                                font: { family: 'Inter', size: 9 }, 
                                maxTicksLimit: 10,
                            },
                            border: { display: true, color: 'rgba(56, 189, 248, 0.3)' },
                            title: { 
                                display: true, 
                                text: 'Longitud (nm)', 
                                color: '#94a3b8', 
                                font: { size: 10, family: 'Inter', weight: 600 } 
                            }
                        }
                    },
                    plugins: {
                        legend: { display: false },
                        tooltip: {
                            enabled: true,
                            backgroundColor: 'rgba(15, 23, 42, 0.9)',
                            titleFont: { size: 11 },
                            bodyFont: { size: 11 }
                        }
                    }
                }
            });
            this.log("✓ Chart.js inicializado correctamente.", "log-sys");
        } catch (e: any) {
            this.log(`❌ Error crítico inicializando Chart.js: ${e.message}`, "log-err");
        }
    }
    consolePaused = false;

    log(msg: string, type = '') {
        const logEntry = {
            id: Date.now() + Math.random(),
            msg,
            type,
            time: new Date().toLocaleTimeString()
        };
        
        this.logs.push(logEntry);
        if (this.logs.length > 500) this.logs.shift();
        
        if (this.onLog) this.onLog([...this.logs]);

        if (this.consolePaused && type !== 'log-sys' && type !== 'log-warn') return; 
        
        // Mantener compatibilidad con elementos DOM directos si existen
        const el = document.getElementById('consoleLog');
        if (el) {
            const d  = document.createElement('div');
            d.className = type;
            d.textContent = '> ' + msg;
            el.prepend(d);
            while (el.children.length > 300) el.removeChild(el.lastChild);
        }
    }

    setLed(id: string, state: boolean, color = 'on-green') {
        const diagId = id.toLowerCase();
        if (this.onHwUpdate) {
            this.onHwUpdate({ [diagId]: state });
        }

        const el = document.getElementById('led' + id);
        if (el) el.className = 'led-badge' + (state ? ' ' + color : '');
        
        // Sync Diagnostic Panel LEDs
        const diagEl = document.getElementById(`diag-led-${diagId}`);
        if (diagEl) {
            diagEl.className = `status-led ${state ? 'led-on' : 'led-off'}`;
        }
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
        ['btnDisc', 'btnDiscNav'].forEach(id => {
            const el = document.getElementById(id) as HTMLButtonElement;
            if (el) el.disabled = !on;
        });
        
        const valMode = document.getElementById('valMode');
        if (valMode) valMode.textContent = on ? this.mode.toUpperCase() : '—';

        if (this.onStatusUpdate) {
            this.onStatusUpdate({
                mode: on ? this.mode.toUpperCase() : '—',
                exp: 10.0, // Default or last known
                temp: 33.5,
                batt: '—',
                pkt: '0 / 0'
            });
        }
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
            const filters: any[] = [
                { namePrefix: 'MicroNIR' },
                { namePrefix: 'MN' }
            ];

            if (this.customServiceUUID && this.customServiceUUID.length >= 4) {
                // Soportar tanto short decodificado como full string
                ALL_POSSIBLE_SERVICES.push(this.customServiceUUID);
                filters.push({ services: [this.customServiceUUID] });
                this.log(`Agregado UUID Manual al escáner: ${this.customServiceUUID}`, 'log-sys');
            }

            let bleDevice = null;
            try {
                this.log('Intentando emparejamiento por prefijo o servicio custom...', 'log-sys');
                bleDevice = await (navigator as any).bluetooth.requestDevice({
                    filters: filters,
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
                this.updateBatteryUI(pctReal);

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
            this.updateBatteryUI(pct);
            this.log(`Nivel Batería (Cmd 0x42): ${pct}% | Payload: ${Array.from(payload).map(b => b.toString(16).padStart(2,'0')).join(' ')}`, 'log-warn');
        } else if (cmd === 0x54 || cmd === this.CMD.TEMP) {
            const t = ((payload[1]||0) | ((payload[2]||0) << 8)) / 10;
            const valTemp = document.getElementById('valTemp');
            if (valTemp) valTemp.textContent = t.toFixed(1) + ' °C';

            if (this.onStatusUpdate) {
                this.onStatusUpdate({
                    mode: this.connected ? this.mode.toUpperCase() : '—',
                    exp: this.HW_REPS ? this.HW_REPS : 10.0,
                    temp: t,
                    batt: '—',
                    pkt: `${this.lastSpectrum.length} / ${this.pktCount}`
                });
            }
        } else if (cmd === 0x52) {
            this.log(`Status Report: ${Array.from(payload).map(b => b.toString(16).padStart(2,'0')).join(' ')}`, 'log-sys');
        }
    }

    updateBatteryUI(pct: number) {
        const valBat = document.getElementById('valBat');
        const valBatHeader = document.getElementById('valBatHeader');
        const batPanel = document.getElementById('batPanel');
        const labelBat = document.getElementById('labelBat');
        
        if (valBat) valBat.textContent = pct + '';
        if (valBatHeader) valBatHeader.textContent = pct + '%';
        
        if (this.onStatusUpdate) {
            this.onStatusUpdate({
                mode: this.connected ? this.mode.toUpperCase() : '—',
                exp: this.HW_REPS ? this.HW_REPS : 10.0,
                temp: 33.5, // Keep last or default if not available
                batt: pct.toString(),
                pkt: `${this.lastSpectrum.length} / ${this.pktCount}`
            });
        }
        
        if (pct < 20) {
            // RED state
            if (valBat) valBat.style.color = '#ef4444';
            if (batPanel) {
                batPanel.style.border = '1px solid #7f1d1d';
                batPanel.style.background = 'rgba(127, 29, 29, 0.2)';
                const icon = batPanel.querySelector('svg') as any;
                if (icon) icon.style.color = '#ef4444';
            }
            if (labelBat) {
                labelBat.textContent = 'BATERÍA CRÍTICA';
                labelBat.style.color = '#ef4444';
            }
        } else {
            // GREEN state (>= 20%)
            if (valBat) valBat.style.color = '#22c55e';
             if (batPanel) {
                batPanel.style.border = '1px solid #064e3b';
                batPanel.style.background = 'rgba(6, 78, 59, 0.2)';
                const icon = batPanel.querySelector('svg') as any;
                if (icon) icon.style.color = '#22c55e';
            }
            if (labelBat) {
                labelBat.textContent = 'BATERÍA OK';
                labelBat.style.color = '#22c55e';
            }
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
        let absData = undefined;

        if (isSample && this.referenceData.dark && this.referenceData.white) {
            absData = data.map((S, i) => {
                const D = this.referenceData.dark![i] || 0;
                const W = this.referenceData.white![i] || 1;
                const R = Math.max((S - D) / (W - D <= 0 ? 1 : W - D), 0.00001);
                return -Math.log10(R);
            });
        }

        const scan: any = {
            id: isSample ? (this.sampleData.id || "N/A") : (Math.random() * 1000).toString(36),
            name: isSample ? (this.sampleData.name || "Muestra") : `Ref_${this.scanTarget}`,
            lot: isSample ? (this.sampleData.lot || "") : "",
            data: [...data],
            absData: absData ? [...absData] : undefined,
            time: Date.now()
        };
        this.history.unshift(scan);
        if (this.history.length > 100) this.history.pop();
        if (this.onHistoryChange) this.onHistoryChange([...this.history]);
        if (this.onHistoryView) this.onHistoryView(null);

        if (isSample) {
            this.sessionHistory.push(scan);
        }

        localStorage.setItem('mn_history', JSON.stringify(this.history));
    }

    deleteHistoryItem(id: string) {
        this.history = this.history.filter(h => h.id !== id);
        localStorage.setItem('mn_history', JSON.stringify(this.history));
        if (this.onHistoryChange) this.onHistoryChange([...this.history]);
    }

    clearHistory() {
        if (!confirm('¿Borrar todo el historial?')) return;
        this.history = [];
        this.sessionHistory = [];
        localStorage.setItem('mn_history', '[]');
        if (this.onHistoryChange) this.onHistoryChange([]);
    }

    renderHistory() {
        // Deprecated - Handled by React
    }

    updateChart(data: number[], pixelCount = 125, forcedMode?: 'abs' | 'counts') {
        if (!data || data.length === 0) return;
        
        const canvas = document.getElementById('nirChart') as HTMLCanvasElement;
        if (!canvas) {
            console.warn("Canvas 'nirChart' not found in DOM");
            return;
        }

        if (!this.chart) {
            this.initChart();
        }
        
        if (!this.chart) {
            console.warn("Chart failed to initialize");
            return;
        }

        const labels = Array.from({length: pixelCount}, (_, i) => {
            const nm = 908.1 + (6.19435 * i);
            return nm.toFixed(1);
        });
        
        try {
            // Clean data to prevent NaN issues
            const cleanData = data.map(v => (isNaN(v) || !isFinite(v)) ? 0 : v);

            this.chart.data.labels = labels;
            this.chart.data.datasets[0].data = cleanData;

            const isAbs = forcedMode === 'abs' || (forcedMode !== 'counts' && this.showAbsorbance);
            
            if (this.chart.options.scales && this.chart.options.scales.y) {
                this.chart.options.scales.y.display = true;
                if (isAbs) {
                    this.chart.options.scales.y.min = -0.1; // Ajuste para visibilidad de línea cero
                    const maxVal = Math.max(...cleanData, 0.1);
                    this.chart.options.scales.y.suggestedMax = maxVal + 0.1;
                    if (this.chart.options.scales.y.title) {
                        this.chart.options.scales.y.title.text = "Absorbancia (AU)";
                    }
                } else {
                    this.chart.options.scales.y.min = -100; // Ajuste para visibilidad de línea cero en counts
                    const maxVal = Math.max(...cleanData, 1000);
                    this.chart.options.scales.y.suggestedMax = maxVal * 1.05;
                    if (this.chart.options.scales.y.title) {
                        this.chart.options.scales.y.title.text = "Intensidad / ADC";
                    }
                }
            }

            if (this.chart.options.scales && this.chart.options.scales.x) {
                this.chart.options.scales.x.display = true;
            }

            this.chart.update('none'); // Update without animation for performance
            
            this.log(`📈 Gráfica actualizada (${cleanData.length} px).`, 'log-sys');
            
            // Critical force draw
            this.chart.draw();
        } catch (err: any) {
            this.log(`❌ Error actualizando gráfica: ${err.message}`, "log-err");
            this.initChart(); 
        }
    }

    clearChart() {
        if (!this.chart) return;
        this.chart.data.datasets[0].data = [];
        if (this.chart.data.datasets[1]) {
            this.chart.data.datasets[1].data = [];
        }
        this.chart.update();
        this.lastSpectrum = [];
        this.sessionHistory = [];
        if (this.onHistoryView) this.onHistoryView(null);
        this.log('Gráfica y sesión de exportación limpiadas.', 'log-sys');
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
        this.log('Solicitud de Referencia Oscura recibida.', 'log-sys');
        if (!this.connected) return alert("Conecta el MicroNIR primero.");
        if (this.onScanState) this.onScanState(true);
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
        if (this.onScanState) this.onScanState(true);
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
        
        if (this.onScanState) this.onScanState(true);
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

    private calculateDisplayData(spectrum: number[], target?: string): number[] {
        const dark = this.referenceData.dark;
        const white = this.referenceData.white;

        if (this.showAbsorbance && dark && white) {
            return spectrum.map((S, i) => {
                const D = (dark && i < dark.length) ? dark[i] : 0;
                const W = (white && i < white.length) ? white[i] : (D + 1);
                const denom = W - D;
                const num = S - D;
                
                // R = (S-D)/(W-D). Cap R <= 1.0 to prevent negative Absorbance
                // If S > W (due to noise), R will be 1.0 -> Abs = 0
                const R = Math.max(Math.min(num / (denom <= 0 ? 1 : denom), 1.0), 0.00001);
                return -Math.log10(R);
            });
        } else if (dark) {
            return spectrum.map((val, i) => Math.max(val - ((dark && i < dark.length) ? dark[i] : 0), 0));
        }
        return [...spectrum];
    }

    async processSpectrum(raw: number[]) {
        if (!this.scanTarget) return;
        const targetAtStart = this.scanTarget;

        try {
            if (raw.length < 256) { 
                this.log(`Datos insuficientes para espectro (${raw.length} bytes)`, 'log-warn'); 
                return; 
            }

            let spectrum: number[] = [];
            let saturatedCount = 0;
            const maxLen = Math.min(256, raw.length);
            for (let i = 0; i < maxLen - 1; i += 2) {
                // RESTORED: MicroNIR uses Big Endian for 16-bit ADC values
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
            if (this.isAveragingInProgress && targetAtStart === 'sample') {
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
            
            if (this.onStatusUpdate) {
                this.onStatusUpdate({
                    mode: this.connected ? this.mode.toUpperCase() : '—',
                    exp: this.HW_REPS || 10.0,
                    temp: 33.5, 
                    batt: '—',
                    pkt: `${spectrum.length} / ${this.pktCount}`
                });
            }
            this.log(`Espectro Recibido (${spectrum.length} px, pkt #${this.pktCount}).`, 'log-sys');
            
            const displayData = this.calculateDisplayData(spectrum, targetAtStart);

            this.updateChart(displayData, spectrum.length);
            this.saveScan(spectrum);
            
            if (targetAtStart === 'white') {
                this.referenceData.white = [...spectrum];
                this.log("✓ Referencia 'WHITE' guardada.", "log-default");
                if (this.onCalibUpdate) {
                    this.onCalibUpdate({ 
                        dark: !!this.referenceData.dark, 
                        white: true 
                    });
                }
            } else if (targetAtStart === 'dark') {
                this.referenceData.dark = [...spectrum];
                this.log("✓ Referencia 'DARK' guardada.", "log-default");
                if (this.onCalibUpdate) {
                    this.onCalibUpdate({ 
                        dark: true, 
                        white: !!this.referenceData.white 
                    });
                }
            } else if (targetAtStart === 'sample') {
                this.log('✓ Análisis completado (Espectro guardado).', 'log-default');

                // LÓGICA DE PREDICCIÓN CON MODELOS JSON
                if (this.currentModels.length > 0 && this.referenceData.dark && this.referenceData.white) {
                    this.log('Iniciando motor de predicción...', 'log-sys');
                    const absorbanceForPrediction = this.calculateDisplayData(spectrum);
                    this.performPrediction(absorbanceForPrediction, true);
                } else if (this.currentModels.length === 0) {
                    this.log('⚠️ AVISO: Muestra capturada pero no hay MODELOS SELECCIONADOS para el cálculo porcentual.', 'log-warn');
                    this.log('Selecciona uno o más modelos en el panel izquierdo (Modelos Cargados) para procesar esta muestra.', 'log-sys');
                }
            }
        } catch (err: any) {
            this.log(`❌ Error crítico procesando espectro: ${err.message}`, "log-err");
        } finally {
            if (this.onScanState) this.onScanState(false);
            if (!this.isAveragingInProgress) {
                // Hard-off LAMP if it was a scan requiring it
                if (targetAtStart === 'white' || targetAtStart === 'sample') {
                    this.sendCmdData([0x21, 0x00, 0x00], 'lamp_off_final');
                }
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
        
        if (this.onAbsorbanceToggle) this.onAbsorbanceToggle(this.showAbsorbance);
        
        this.updateChartStatus();
        
        if (this.lastSpectrum.length > 0) {
            const displayData = this.calculateDisplayData(this.lastSpectrum);
            this.updateChart(displayData, this.lastSpectrum.length);
        }
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
        // Usar sessionHistory para exportación acumulada de la sesión
        const samples = this.sessionHistory;
        
        if (samples.length === 0) {
            if (!this.lastSpectrum.length) { 
                this.log('Sin datos en la sesión para exportar.', 'log-warn'); 
                return; 
            }
            // Fallback: Si no hay historial de sesión pero hay un espectro actual
            this.log('Exportando análisis actual...', 'log-default');
            samples.push({
                id: this.sampleData.id || "N/A",
                name: this.sampleData.name || "Muestra_Actual",
                lot: this.sampleData.lot || "N/A",
                data: [...this.lastSpectrum],
                time: Date.now()
            });
        }

        // Cabeceras: 125 Longitudes de onda con ajuste lineal exacto
        const wavelengths = Array.from({length: 125}, (_, i) => (908.1 + (6.19435 * i)).toFixed(4));
        
        // Determinar qué propiedades predictivas existen en la sesión para añadirlas como columnas
        const predictionProps = new Set<string>();
        samples.forEach(s => {
            if (s.allPredictions) {
                s.allPredictions.forEach((p: any) => predictionProps.add(p.property));
            } else if (s.propName && s.prediction !== undefined) {
                predictionProps.add(s.propName);
            }
        });
        const propList = Array.from(predictionProps);

        const header = ["Fecha/Hora", "Muestra", "ID Muestra", "Lote/Info", ...wavelengths];
        
        // Añadir columnas de resultados
        propList.forEach(prop => {
            header.push(`Resultado: ${prop}`);
            header.push(`GH: ${prop}`);
        });

        header.push("Número de Serie", "Usuario", "Temperatura (°C)", "Ti (ms)", "Réplicas");

        const rows = samples.map(item => {
            const dateStr = new Date(item.time).toLocaleString();
            
            // Usamos la lógica centralizada forzando absorbancia si hay referencias
            const wasAbs = this.showAbsorbance;
            this.showAbsorbance = !!(this.referenceData.dark && this.referenceData.white);
            const processedData = this.calculateDisplayData(item.data);
            this.showAbsorbance = wasAbs; // Restaurar estado UI

            const dataRow = processedData.map((val: number) => {
                if (this.referenceData.dark && this.referenceData.white) {
                    return val.toFixed(5);
                }
                return val.toFixed(0); 
            });

            const connectedName = this.bleDevice?.name || document.getElementById('devId')?.textContent || "M1-0000343";
            const cleanSerial = connectedName.replace('MicroNIR ', '').replace('MN ', '').replace('FTDI VID:', 'USB-').trim();
            const temp = document.getElementById('valTemp')?.textContent?.replace('°C', '') || "25.0";
            const exp = document.getElementById('valExp')?.textContent?.replace(' ms', '') || "12.5";

            const baseRow = [
                `"${dateStr}"`,
                `"${item.name}"`,
                `"${item.id}"`,
                `"${item.lot || 'N/A'}"`,
                ...dataRow
            ];

            // Añadir valores de predicción
            propList.forEach(prop => {
                let val = "N/A";
                let gh = "N/A";
                if (item.allPredictions) {
                    const pred = item.allPredictions.find((p: any) => p.property === prop);
                    if (pred) {
                        val = pred.value.toFixed(2);
                        gh = pred.gh.toFixed(2);
                    }
                } else if (item.propName === prop && item.prediction !== undefined) {
                    val = item.prediction.toFixed(2);
                    gh = item.gh?.toFixed(2) || "N/A";
                }
                baseRow.push(val);
                baseRow.push(gh);
            });

            // Añadir campos finales
            baseRow.push(cleanSerial, "Spectra-Nir User", temp, exp, "4");

            return baseRow.join(',');
        });

        const csvContent = [header.join(','), ...rows].join('\n');
        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement("a");
        const url = URL.createObjectURL(blob);
        const fileName = samples.length === 1 ? `Analisis_${samples[0].name}.csv` : `Sesion_Analisis_${new Date().toISOString().slice(0,10)}.csv`;
        
        link.setAttribute("href", url);
        link.setAttribute("download", fileName);
        link.style.visibility = 'hidden';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        
        this.log(`✓ CSV exportado (${samples.length} análisis acumulados).`, 'log-default');
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

    performPrediction(absorbance: number[], isSampleScan = false) {
        try {
            const models = this.currentModels;
            if (!models || models.length === 0) return;
            if (this.onPredictionState) this.onPredictionState(true);
            
            this.log(`Iniciando motor de predicción para ${models.length} modelos...`, 'log-sys');
            
            // Usamos un pequeño timeout para no bloquear el hilo UI si hay muchos modelos
            setTimeout(() => {
                try {
                    const results: PredictionResult[] = [];
                    
                    for (const m of models) {
                        try {
                            const prop = m.json.analyticalProperty || m.name;
                            // Capturamos el log para prefijarlo con el nombre de la propiedad
                            const res = predict(absorbance, m.json, (msg, type) => this.log(`[${prop}] ${msg}`, type));
                            
                            // APLICAR BIAS Y SLOPE
                            const devKey = this.getDeviceKey();
                            const modelKey = `${devKey}_${m.product}`;
                            const settings = this.biasSettings[modelKey]?.[prop] || { bias: 0, slope: 1 };
                            
                            const rawValue = res.value;
                            const correctedValue = (rawValue * settings.slope) + settings.bias;
                            
                            res.value = correctedValue;
                            
                            results.push(res);
                            this.log(`Predicción [${prop}]: ${res.value.toFixed(2)} ${res.unit} (Original: ${rawValue.toFixed(2)}, Bias: ${settings.bias}, Slope: ${settings.slope})`, 'log-warn');
                        } catch (err: any) {
                            this.log(`Error en modelo ${m.json.analyticalProperty || m.name}: ${err.message}`, 'log-err');
                        }
                    }

                    // Actualizar el registro en el historial
                    if (this.history.length > 0 && isSampleScan && results.length > 0) {
                        const last: any = this.history[0];
                        // Guardamos el primer resultado como primario para la vista simplificada
                        last.prediction = results.length === 1 ? results[0].value : undefined;
                        last.gh = results.length === 1 ? results[0].gh : undefined;
                        last.unit = results.length === 1 ? results[0].unit : undefined;
                        last.propName = results.length === 1 ? results[0].property : "Análisis Múltiple";
                        // Almacenamos el array completo para futuras consultas
                        last.allPredictions = results;
                        last.absData = absorbance;

                        // También actualizar en el historial de sesión (CSV acumulado)
                        const sessionItem = this.sessionHistory.find(h => h.time === last.time);
                        if (sessionItem) {
                            sessionItem.prediction = last.prediction;
                            sessionItem.gh = last.gh;
                            sessionItem.unit = last.unit;
                            sessionItem.propName = last.propName;
                            sessionItem.allPredictions = results;
                            sessionItem.absData = absorbance;
                        }

                        localStorage.setItem('mn_history', JSON.stringify(this.history));
                        if (this.onHistoryChange) this.onHistoryChange([...this.history]);
                    }

                    if (this.onPredictions) this.onPredictions(results);
                    if (this.onPredictionState) this.onPredictionState(false);
                } catch (e: any) {
                    this.log(`Fallo en procesamiento de modelos: ${e.message}`, 'log-err');
                    if (this.onPredictionState) this.onPredictionState(false);
                }
            }, 100);

        } catch (e: any) {
            this.log(`Fallo al iniciar motor multi-modelo: ${e.message}`, 'log-err');
            if (this.onPredictionState) this.onPredictionState(false);
        }
    }

    sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

    getDeviceKey() {
        const connectedName = this.bleDevice?.name || document.getElementById('devId')?.textContent || "M1-0000343";
        return connectedName.replace('MicroNIR ', '').replace('MN ', '').replace('FTDI VID:', 'USB-').trim();
    }

    saveBiasSettings(modelProduct: string, settings: Record<string, { bias: number, slope: number }>) {
        const devKey = this.getDeviceKey();
        const modelKey = `${devKey}_${modelProduct}`;
        this.biasSettings[modelKey] = settings;
        localStorage.setItem('mn_bias_settings', JSON.stringify(this.biasSettings));
        this.log(`✓ Ajustes de Bias/Slope guardados para ${modelProduct} en equipo ${devKey}`, 'log-warn');
    }
}

const getProductIcon = (productName: string) => {
    const p = productName.toLowerCase();
    if (p.includes('maiz') || p.includes('sorgo')) return <Sprout size={16} style={{ color: '#38bdf8' }} />;
    if (p.includes('soya')) return <Leaf size={16} style={{ color: '#38bdf8' }} />;
    if (p.includes('canola')) return <Flower2 size={16} style={{ color: '#38bdf8' }} />;
    if (p.includes('trigo') || p.includes('salvado')) return <Wheat size={16} style={{ color: '#38bdf8' }} />;
    if (p.includes('ddgs')) return <FlaskConical size={16} style={{ color: '#38bdf8' }} />;
    if (p.includes('carne') || p.includes('cerdo') || p.includes('pollo')) return <Beef size={16} style={{ color: '#38bdf8' }} />;
    if (p.includes('pescado')) return <Fish size={16} style={{ color: '#38bdf8' }} />;
    return <Package size={16} style={{ color: '#38bdf8' }} />;
};

export default function App() {
    const appRef = useRef<MicroNIRApp | null>(null);
    const [calib, setCalib] = useState({ dark: false, white: false });
    const [models, setModels] = useState<PredictionModel[]>(() => {
        const saved = localStorage.getItem('mn_models');
        return saved ? JSON.parse(saved) : [];
    });
    const [history, setHistory] = useState<any[]>([]);
    const [selectedModelIds, setSelectedModelIds] = useState<string[]>(() => {
        const saved = localStorage.getItem('mn_selected_models');
        return saved ? JSON.parse(saved) : [];
    });

    const uniqueProducts = Array.from(new Set(models.map(m => m.product))).sort();
    
    // Cloud Library State
    const [cloudUrl, setCloudUrl] = useState(() => localStorage.getItem('mn_cloud_url') || '');
    const [cloudFolders, setCloudFolders] = useState<{name: string, id: string}[]>([]);
    const [selectedFolder, setSelectedFolder] = useState('');
    const [isSyncing, setIsSyncing] = useState(false);
    const [customUuid, setCustomUuid] = useState(() => localStorage.getItem('mn_custom_uuid') || '');
    
    // Bias & Slope State
    const [isBiasModalOpen, setIsBiasModalOpen] = useState(false);
    const [biasTargetModel, setBiasTargetModel] = useState<PredictionModel | null>(null);
    const [biasState, setBiasState] = useState<Record<string, { bias: number, slope: number }>>({});

    useEffect(() => {
        localStorage.setItem('mn_cloud_url', cloudUrl);
    }, [cloudUrl]);

    useEffect(() => {
        localStorage.setItem('mn_custom_uuid', customUuid);
        if (appRef.current) {
            appRef.current.customServiceUUID = customUuid || null;
        }
    }, [customUuid]);

    const syncLibrary = async () => {
        if (!cloudUrl) return alert("Por favor ingresa la URL de la Aplicación Web de Google Script.");
        setIsSyncing(true);
        app()?.log("Sincronizando con Google Drive...", "log-sys");
        try {
            const joinChar = cloudUrl.includes('?') ? '&' : '?';
            const response = await fetch(cloudUrl + joinChar + "action=getFolders");
            const data = await response.json();
            if (data.status === "success") {
                setCloudFolders(data.folders);
                app()?.log(`Sincronización exitosa. ${data.folders.length} materias primas encontradas.`, "log-warn");
            } else {
                throw new Error(data.message);
            }
        } catch (err: any) {
            app()?.log("Error de sincronización: " + err.message, "log-err");
            alert("Error al conectar con Google Drive. Verifica la URL y que el script esté publicado como 'Cualquier persona'.");
        } finally {
            setIsSyncing(false);
        }
    };

    const loadLocalModel = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (event) => {
            try {
                const jsonObj = JSON.parse(event.target?.result as string);
                
                // Prompt user to give a product name for the local model
                const productName = window.prompt("Ingrese el nombre de la matriz (Materia Prima) para este modelo:", "LOCAL");
                if (!productName) return;

                const newModel: PredictionModel = {
                    id: crypto.randomUUID(),
                    name: jsonObj.analyticalProperty || file.name.replace('.json', ''),
                    product: productName.toUpperCase(),
                    json: jsonObj
                };

                setModels(prev => {
                    const filtered = prev.filter(p => !(p.product === newModel.product && p.name === newModel.name));
                    return [...filtered, newModel];
                });

                setSelectedModelIds(prev => [...prev, newModel.id]);
                app()?.log(`✓ Modelo local "${newModel.name}" cargado para ${newModel.product}.`, "log-warn");
            } catch (err: any) {
                app()?.log("Error al cargar modelo local: " + err.message, "log-err");
                alert("Error al procesar el archivo JSON.");
            }
        };
        reader.readAsText(file);
        // Reset the input so the same file could be selected again if needed
        e.target.value = '';
    };

    const loadFolderModels = async (folderId: string) => {
        if (!folderId) return;
        const folder = cloudFolders.find(f => f.id === folderId);
        const folderName = folder ? folder.name.toUpperCase() : 'DESCONOCIDO';
        
        setSelectedFolder(folderId);
        setIsSyncing(true);
        app()?.log(`Cargando modelos para ${folderName}...`, "log-sys");
        try {
            const joinChar = cloudUrl.includes('?') ? '&' : '?';
            const response = await fetch(`${cloudUrl}${joinChar}action=getModels&folderId=${folderId}`);
            const data = await response.json();
            if (data.status === "success") {
                const newModels: PredictionModel[] = data.models.map((m: any) => ({
                    id: crypto.randomUUID(),
                    name: m.analyticalProperty || m.fileName.replace('.json', ''),
                    product: folderName,
                    json: m
                }));
                // Limpiar modelos locales previos de la misma materia prima para evitar duplicados
                setModels(prev => {
                    const filtered = prev.filter(p => !newModels.some(n => n.product === p.product && n.name === p.name));
                    const next = [...filtered, ...newModels];
                    return next;
                });

                // AUTO-SELECCIÓN: Activar todos los modelos de la materia prima seleccionada
                if (newModels.length > 0) {
                    setSelectedModelIds(newModels.map(nm => nm.id));
                    app()?.log(`✓ Materia prima ${folderName} vinculada con ${newModels.length} parámetros.`, "log-warn");
                }

                app()?.log(`✓ ${newModels.length} modelos cargados correctamente.`, "log-warn");
            } else {
                throw new Error(data.message);
            }
        } catch (err: any) {
            app()?.log("Error al cargar modelos: " + err.message, "log-err");
        } finally {
            setIsSyncing(false);
        }
    };

    const [predictionResults, setPredictionResults] = useState<PredictionResult[]>([]);
    const [isScanning, setIsScanning] = useState(false);
    const [isPredicting, setIsPredicting] = useState(false);
    const [activeMenu, setActiveMenu] = useState<'config' | 'analysis' | 'diag' | 'models'>('analysis');
    const [isSidebarHovered, setIsSidebarHovered] = useState(false);

    useEffect(() => {
        localStorage.setItem('mn_models', JSON.stringify(models));
    }, [models]);

    useEffect(() => {
        localStorage.setItem('mn_selected_models', JSON.stringify(selectedModelIds));
    }, [selectedModelIds]);
    const [isSidebarOpen, setIsSidebarOpen] = useState(true);
    const [isUartUnlocked, setIsUartUnlocked] = useState(false);
    const [showAbsorbance, setShowAbsorbance] = useState(false);
    const [viewedHistoryItem, setViewedHistoryItem] = useState<any | null>(null);
    const [appStatus, setAppStatus] = useState({
        mode: '—',
        exp: 10.0,
        temp: 33.5,
        batt: '—',
        pkt: '0 / 0'
    });

    const generatePDF = (item: any) => {
        const doc = new jsPDF();
        
        // Header
        doc.setFontSize(22);
        doc.setTextColor(14, 165, 233);
        doc.text("Reporte de Análisis NIR", 105, 20, { align: "center" });
        
        doc.setFontSize(10);
        doc.setTextColor(100);
        doc.text(`Generado el: ${new Date().toLocaleString()}`, 105, 28, { align: "center" });
        
        // Device Info
        const devKey = appRef.current?.getDeviceKey() || 'N/A';
        doc.setFontSize(12);
        doc.setTextColor(0);
        doc.text("Información del Equipo", 20, 45);
        doc.setLineWidth(0.5);
        doc.line(20, 47, 190, 47);
        
        doc.setFontSize(10);
        doc.text(`Equipo: MicroNIR ${devKey}`, 25, 55);
        
        // Sample Info
        doc.setFontSize(12);
        doc.text("Datos de la Muestra", 20, 70);
        doc.line(20, 72, 190, 72);
        
        doc.setFontSize(10);
        doc.text(`Carga / Producto: ${item.name}`, 25, 80);
        doc.text(`ID / Lote: ${item.id} ${item.lot ? `/ ${item.lot}` : ''}`, 25, 86);
        doc.text(`Fecha de Escaneo: ${new Date(item.time).toLocaleString()}`, 25, 92);
        
        // Results Table
        doc.setFontSize(12);
        doc.text("Resultados Analíticos", 20, 110);
        
        const tableRows: any[] = [];
        if (item.allPredictions) {
            item.allPredictions.forEach((p: any) => {
                tableRows.push([p.property.toUpperCase(), `${p.value.toFixed(2)} ${p.unit || '%'}`, p.gh.toFixed(2), p.gh > 3 ? 'Fuera de Rango' : 'Válido']);
            });
        } else if (item.prediction !== undefined) {
            tableRows.push([(item.propName || 'Proteína').toUpperCase(), `${item.prediction.toFixed(2)} ${item.unit || '%'}`, item.gh.toFixed(2), item.gh > 3 ? 'Fuera de Rango' : 'Válido']);
        }
        
        autoTable(doc, {
            startY: 115,
            head: [['Propiedad', 'Valor', 'GH (Puntaje)', 'Estado']],
            body: tableRows,
            theme: 'grid',
            headStyles: { fillColor: [14, 165, 233], textColor: [255, 255, 255], fontStyle: 'bold' },
            styles: { fontSize: 10, cellPadding: 5 },
            columnStyles: {
                0: { fontStyle: 'bold' },
                2: { halign: 'center' },
                3: { halign: 'center' }
            }
        });
        
        // Footer
        const finalY = (doc as any).lastAutoTable.finalY + 30;
        if (finalY < 270) {
            doc.setFontSize(8);
            doc.setTextColor(150);
            doc.text("Nota: Este análisis es una predicción basada en modelos quimiométricos NIR.", 20, finalY);
            doc.text("Documento generado digitalmente por MicroNIR Setup Tool.", 20, finalY + 5);
        }
        
        doc.save(`Reporte_NIR_${item.name}_${item.id}.pdf`);
    };

    const unlockUart = () => {
        const pass = window.prompt("Ingrese clave de administrador para Monitor UART:");
        if (pass === 'UART1234') {
            setIsUartUnlocked(true);
        } else if (pass !== null) {
            alert("Clave incorrecta.");
        }
    };

    const [diagLogs, setDiagLogs] = useState<any[]>([]);
    const [hwStatus, setHwStatus] = useState<Record<string, boolean>>({
        mcu: false,
        lamp: false,
        adc: false,
        pwr: false
    });

    useEffect(() => {
        if (!appRef.current) {
            appRef.current = new MicroNIRApp();
            appRef.current.onCalibUpdate = (status) => {
                setCalib(status);
            };
            appRef.current.onPredictions = (res) => {
                setPredictionResults(res);
            };
            appRef.current.onHistoryChange = (h) => {
                setHistory(h);
            };
            appRef.current.onStatusUpdate = (s) => {
                setAppStatus(s);
            };
            appRef.current.onScanState = (s) => {
                setIsScanning(s);
            };
            appRef.current.onLog = (logs) => {
                setDiagLogs(logs);
            };
            appRef.current.onHwUpdate = (hw) => {
                setHwStatus(prev => ({ ...prev, ...hw }));
            };
            appRef.current.onPredictionState = (loading) => {
                setIsPredicting(loading);
            };
            appRef.current.onAbsorbanceToggle = (active) => {
                setShowAbsorbance(active);
            };
            appRef.current.onHistoryView = (item) => {
                setViewedHistoryItem(item);
            };
            appRef.current.initChart();
            appRef.current.setMode('ble');
            appRef.current.renderHistory();
        }

        // Intervalo de seguridad para asegurar que el gráfico esté inicializado
        const chartInterval = setInterval(() => {
            if (appRef.current && !appRef.current.chart) {
                appRef.current.initChart();
            }
        }, 2000);

        return () => clearInterval(chartInterval);
    }, []);

    useEffect(() => {
        if (viewedHistoryItem && appRef.current) {
            const dataToShow = viewedHistoryItem.absData || viewedHistoryItem.data;
            const isAbs = !!viewedHistoryItem.absData;
            appRef.current.updateChart(dataToShow, dataToShow.length, isAbs ? 'abs' : 'counts');
        }
    }, [viewedHistoryItem]);

    useEffect(() => {
        const a = app();
        if (a) {
            const selectedModels = models.filter(m => selectedModelIds.includes(m.id));
            a.currentModels = selectedModels;
            console.log('Modelos actualizados en app instance:', a.currentModels.length, selectedModelIds);
            if (selectedModels.length > 0) {
                a.log(`Modelos activos para predicción: ${selectedModels.map(m => m.product).join(', ')}`, 'log-sys');
            } else {
                a.log('No hay modelos seleccionados para predicción.', 'log-sys');
            }
        }
    }, [selectedModelIds, models]);

    // Efecto de limpieza y auto-selección de modelos
    useEffect(() => {
        if (models.length > 0) {
            const validIds = selectedModelIds.filter(id => models.some(m => m.id === id));
            if (validIds.length !== selectedModelIds.length) {
                setSelectedModelIds(validIds);
            }
        }
    }, [models, selectedModelIds.length]);

    const logEndRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (activeMenu === 'diag') {
            logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
        }
    }, [diagLogs, activeMenu]);

    useEffect(() => {
        if (activeMenu === 'analysis' && appRef.current) {
            // Increase timeout to ensure AnimatePresence has finished mounting the DOM
            setTimeout(() => {
                const appInstance = appRef.current;
                if (!appInstance) return;
                
                appInstance.initChart();
                if (appInstance.lastSpectrum && appInstance.lastSpectrum.length > 0) {
                     // Re-calculate based on current view settings
                     const displayData = (appInstance as any).calculateDisplayData(appInstance.lastSpectrum);
                     appInstance.updateChart(displayData, appInstance.lastSpectrum.length);
                }
            }, 400);
        }
    }, [activeMenu]);

    const app = () => appRef.current;

    return (
        <>
            <header className="ind-panel" style={{ borderBottom: '1px solid rgba(14, 165, 233, 0.2)', marginBottom: '0', borderRadius: '0' }}>
                <div className="logo" style={{ cursor: 'pointer' }} onClick={() => setActiveMenu('analysis')}>
                    <div className="logo-icon">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--secondary)" strokeWidth="3">
                            <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
                        </svg>
                    </div>
                    <div>
                        <div className="logo-text">Spectra<span>Nir</span></div>
                        <div style={{ fontSize: '0.6rem', color: '#38bdf8', fontWeight: '800', opacity: 0.6 }}>RSS</div>
                    </div>
                </div>

                <div className="status-compact">
                    <div className="ind-inset" style={{ padding: '6px 12px', display: 'flex', alignItems: 'center', gap: '10px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                            <div className="dot" style={{ 
                                width: '8px', 
                                height: '8px', 
                                borderRadius: '50%', 
                                backgroundColor: calib.dark && calib.white ? '#4ade80' : '#fb923c',
                                boxShadow: calib.dark && calib.white ? '0 0 10px #4ade80' : '0 0 10px #fb923c'
                            }}></div>
                            <span style={{ fontSize: '0.65rem', fontWeight: '900', color: '#cbd5e1' }}>CALIBRACIÓN: {calib.dark && calib.white ? 'OK' : 'PENDIENTE'}</span>
                        </div>
                        <div style={{ width: '1px', height: '14px', background: 'rgba(255,255,255,0.1)' }}></div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                            <Battery size={14} style={{ color: '#f97316' }} />
                            <span id="valBatHeader" style={{ fontSize: '0.65rem', fontWeight: '900', color: '#cbd5e1', fontFamily: 'var(--mono)' }}>—%</span>
                        </div>
                        <div style={{ width: '1px', height: '14px', background: 'rgba(255,255,255,0.1)' }}></div>
                        <div id="statusPill" className="status-pill connected" style={{ padding: '2px 8px', border: 'none', background: 'transparent' }}>
                             <div className="dot"></div>
                             <span id="statusText" style={{ fontWeight: '900', fontSize: '0.65rem' }}>CONECTADO</span>
                        </div>
                    </div>
                </div>
            </header>

            <div className="main-content">
                <nav className={`sidebar-mini ${isSidebarHovered ? 'expanded' : ''}`}
                     onMouseEnter={() => setIsSidebarHovered(true)}
                     onMouseLeave={() => setIsSidebarHovered(false)}>
                    
                    <div style={{ flex: 1, width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px' }}>
                        <div 
                            className={`nav-item ${activeMenu === 'analysis' ? 'active' : ''}`}
                            onClick={() => setActiveMenu('analysis')}
                            title="Operaciones de Análisis"
                        >
                            <BarChart3 size={20} />
                            {isSidebarHovered && <span className="nav-label">Análisis</span>}
                        </div>

                        <div 
                            className={`nav-item ${activeMenu === 'models' ? 'active' : ''}`}
                            onClick={() => setActiveMenu('models')}
                            title="Gestión de Modelos"
                        >
                            <Cloud size={20} />
                            {isSidebarHovered && <span className="nav-label">Modelos</span>}
                        </div>

                        <div 
                            className={`nav-item ${activeMenu === 'config' ? 'active' : ''}`}
                            onClick={() => setActiveMenu('config')}
                            title="Configuración de Sistema"
                        >
                            <Settings size={20} />
                            {isSidebarHovered && <span className="nav-label">Ajustes</span>}
                        </div>

                        <div 
                            className={`nav-item ${activeMenu === 'diag' ? 'active' : ''}`}
                            onClick={() => setActiveMenu('diag')}
                            title="Diagnóstico y Soporte"
                        >
                            <ShieldAlert size={20} />
                            {isSidebarHovered && <span className="nav-label">Diagnóstico</span>}
                        </div>

                        <div 
                            className="nav-item"
                            onClick={() => app()?.connect()}
                            title="Conectar MicroNIR"
                            style={{ 
                                marginTop: '10px', 
                                border: '1px solid rgba(56, 189, 248, 0.2)',
                                cursor: 'pointer'
                            }}
                        >
                            <Bluetooth size={20} style={{ color: '#38bdf8' }} />
                            {isSidebarHovered && <span className="nav-label" style={{ color: '#38bdf8', fontWeight: '950' }}>CONECTAR</span>}
                        </div>

                        <div 
                            id="btnDiscNav"
                            className="nav-item"
                            onClick={() => app()?.disconnect().then(() => window.location.reload())}
                            title="Desconectar Dispositivo"
                            style={{ 
                                marginTop: '10px', 
                                border: '1px solid rgba(239, 68, 68, 0.1)',
                                cursor: 'pointer'
                            }}
                        >
                            <PowerOff size={20} style={{ color: '#ef4444' }} />
                            {isSidebarHovered && <span className="nav-label" style={{ color: '#ef4444', fontWeight: '950' }}>DESCONECTAR</span>}
                        </div>
                    </div>
                </nav>

                <main className="content" style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
                    <AnimatePresence mode="wait">
                        {activeMenu === 'analysis' && (
                            <motion.div 
                                key="analysis"
                                initial={{ opacity: 0, x: 20 }}
                                animate={{ opacity: 1, x: 0 }}
                                exit={{ opacity: 0, x: -20 }}
                                transition={{ duration: 0.2 }}
                                style={{ height: '100%', overflowY: 'auto', padding: '20px', display: 'flex', flexDirection: 'column', gap: '15px' }}
                            >
                                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '12px' }}>
                                    {[
                                        { label: 'CANAL DATOS', val: appStatus.mode, icon: <Activity size={10} /> },
                                        { label: 'INT. (MS)', val: appStatus.exp.toFixed(1), icon: <Clock size={10} /> },
                                        { label: 'TEMP', val: `${appStatus.temp.toFixed(1)}°C`, icon: <Thermometer size={10} /> },
                                        { label: 'BATERÍA', val: `${appStatus.batt} %`, icon: <Battery size={10} /> },
                                        { label: 'PRODUCTO', val: models.find(m => m.id === selectedModelIds[0])?.product || 'NONE', icon: <Database size={10} /> },
                                    ].map((m, i) => (
                                        <div key={i} className="ind-panel m-glow-blue" style={{ display: 'flex', flexDirection: 'column', gap: '6px', padding: '10px' }}>
                                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                                <span style={{ fontSize: '0.55rem', color: '#38bdf8', fontWeight: '900', letterSpacing: '0.05em' }}>{m.label}</span>
                                                {m.icon}
                                            </div>
                                            <div className="ind-inset" style={{ textAlign: 'center', padding: '6px 0' }}>
                                                <span style={{ fontSize: '1rem', fontWeight: '900', color: '#fff', fontFamily: 'var(--mono)' }}>{m.val}</span>
                                            </div>
                                        </div>
                                    ))}
                                </div>

                    <div id="progressContainer" style={{display:'none', background:'rgba(0,184,217,0.05)', borderRadius:'6px', padding:'12px', border:'1px solid rgba(0,184,217,0.1)', marginBottom:'0px'}}>
                        <div style={{display:'flex', justifyContent:'space-between', marginBottom:'10px'}}>
                            <span className="label" style={{fontSize:'0.75rem', color:'var(--primary)', fontFamily:'Share Tech Mono', fontWeight:'bold'}}>PROGRESO DE INTEGRACIÓN</span>
                            <span id="progressText" className="val" style={{fontSize:'0.75rem', color:'var(--primary)', fontFamily:'Share Tech Mono'}}>0%</span>
                        </div>
                        <div style={{width:'100%', height:'8px', background:'rgba(255,255,255,0.05)', borderRadius:'4px', overflow:'hidden', border:'1px solid rgba(255,255,255,0.05)'}}>
                            <div id="progressBar" style={{width:'0%', height:'100%', background:'var(--primary)', transition:'width 0.15s ease'}}></div>
                        </div>
                    </div>

                    <div className="ind-panel" style={{ 
                        display: 'flex', 
                        gap: '12px', 
                        padding: '12px', 
                        alignItems: 'stretch' 
                    }}>
                        <div style={{ 
                            display: 'flex', 
                            flexDirection: 'column', 
                            justifyContent: 'center',
                            paddingRight: '15px',
                            borderRight: '1px solid var(--border)',
                            marginRight: '5px'
                        }}>
                             <div style={{ color: 'var(--dim)', fontSize: '0.55rem', fontWeight: '800', textTransform: 'uppercase', letterSpacing: '0.1em' }}>PROTOCOLO DE</div>
                             <div style={{ color: '#fff', fontSize: '0.85rem', fontWeight: '900', letterSpacing: '0.05em' }}>CALIBRACIÓN</div>
                        </div>
                        
                        <motion.button 
                            id="btnDark" 
                            className={`step-card ${calib.dark ? 'completed' : 'active'} ${isScanning ? 'scanning' : ''}`} 
                            onClick={() => app()?.setDarkReference()} 
                            style={{ padding: '10px', position: 'relative', overflow: 'hidden' }}
                            whileHover={{ scale: 1.05, background: 'rgba(56, 189, 248, 0.15)' }}
                            whileTap={{ scale: 0.95 }}
                            animate={isScanning ? {
                                boxShadow: ['0 0 0px rgba(56, 189, 248, 0.2)', '0 0 15px rgba(56, 189, 248, 0.6)', '0 0 0px rgba(56, 189, 248, 0.2)'],
                                borderColor: ['rgba(56, 189, 248, 0.4)', 'rgba(56, 189, 248, 1)', 'rgba(56, 189, 248, 0.4)']
                            } : {}}
                            transition={isScanning ? { repeat: Infinity, duration: 1 } : { duration: 0.2 }}
                        >
                            <Moon size={16} style={{ marginBottom: '4px' }} className={isScanning ? 'animate-pulse' : ''} />
                            <span style={{ fontSize: '0.5rem', fontWeight: '900', marginBottom: '1px', opacity: 0.6 }}>
                                {isScanning ? 'LEYENDO...' : (calib.dark ? '✓ COMPLETADO' : 'PASO 01')}
                            </span>
                            <span style={{ fontSize: '0.7rem', fontWeight: '900' }}>OSCURIDAD</span>
                            {isScanning && (
                                <motion.div 
                                    style={{ position: 'absolute', bottom: 0, left: 0, height: '2px', background: '#38bdf8' }}
                                    initial={{ width: '0%' }}
                                    animate={{ width: '100%' }}
                                    transition={{ duration: 3, repeat: Infinity }}
                                />
                            )}
                        </motion.button>
                        
                        <motion.button 
                            id="btnWhite" 
                            className={`step-card ${calib.white ? 'completed' : (calib.dark ? 'active' : '')} ${isScanning ? 'scanning' : ''}`} 
                            onClick={() => app()?.setWhiteReference()} 
                            style={{ padding: '10px', position: 'relative', overflow: 'hidden' }}
                            whileHover={{ scale: 1.05, background: 'rgba(56, 189, 248, 0.15)' }}
                            whileTap={{ scale: 0.95 }}
                            animate={isScanning ? {
                                boxShadow: ['0 0 0px rgba(56, 189, 248, 0.2)', '0 0 15px rgba(56, 189, 248, 0.6)', '0 0 0px rgba(56, 189, 248, 0.2)'],
                                borderColor: ['rgba(56, 189, 248, 0.4)', 'rgba(56, 189, 248, 1)', 'rgba(56, 189, 248, 0.4)']
                            } : {}}
                            transition={isScanning ? { repeat: Infinity, duration: 1 } : { duration: 0.2 }}
                        >
                            <Sun size={16} style={{ marginBottom: '4px' }} className={isScanning ? 'animate-pulse' : ''} />
                            <span style={{ fontSize: '0.5rem', fontWeight: '900', marginBottom: '1px', opacity: 0.6 }}>
                                {isScanning ? 'LEYENDO...' : (calib.white ? '✓ COMPLETADO' : 'PASO 02')}
                            </span>
                            <span style={{ fontSize: '0.7rem', fontWeight: '900' }}>BLANCO REFE.</span>
                        </motion.button>
                        
                        <button id="btnAbs" className="btn-action" 
                            onClick={() => {
                                console.log('Botón Analizar Muestra clicado');
                                setPredictionResults([]);
                                const instance = app();
                                if (instance) {
                                    instance.log('Solicitud de análisis de muestra iniciada...', 'log-sys');
                                    instance.scanSample();
                                } else {
                                    console.error('Instancia de app no disponible');
                                }
                            }} 
                            disabled={!(calib.dark && calib.white)}
                            style={{ 
                            flex: 1.5, 
                            borderRadius: '6px',
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: 'center',
                            justifyContent: 'center',
                            padding: '10px',
                            transition: 'all 0.2s',
                            position: 'relative',
                            overflow: 'hidden',
                            cursor: (calib.dark && calib.white) ? 'pointer' : 'not-allowed',
                            opacity: (calib.dark && calib.white) ? 1 : 0.5
                        }}>
                            <Zap size={18} style={{ marginBottom: '4px' }} />
                            <span style={{ fontSize: '0.5rem', fontWeight: '900', marginBottom: '1px', opacity: 0.8 }}>PASO 03</span>
                            <span style={{ fontSize: '1rem', fontWeight: '950', letterSpacing: '0.05em' }}>ANALIZAR MUESTRA</span>
                        </button>
                    </div>

                    <div className="dashboard-main" style={{ display: 'flex', gap: '15px', height: '620px', minHeight: '620px' }}>
                        {/* LADO IZQUIERDO: ESPECTRO */}
                        <div className="ind-panel" style={{ flex: 7, display: 'flex', flexDirection: 'column', padding: '15px', overflow: 'hidden' }}>
                            <div className="chart-hdr" style={{ marginBottom: '12px', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                                <div>
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', minWidth: '350px' }}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '2px' }}>
                                            <span style={{ fontSize: '0.65rem', color: '#38bdf8', fontWeight: '900', letterSpacing: '0.08em' }}>SELECCIONAR MATERIA PRIMA</span>
                                        </div>
                                        <div style={{ position: 'relative' }}>
                                            <select 
                                                value={selectedModelIds.length > 0 ? (models.find(m => m.id === selectedModelIds[0])?.product || '') : ''}
                                                onChange={(e) => {
                                                    const product = e.target.value;
                                                    const ids = models.filter(m => m.product === product).map(m => m.id);
                                                    setSelectedModelIds(ids);
                                                    app()?.log(`✓ Producto cambiado a: ${product} (${ids.length} parámetros)`, 'log-warn');
                                                }}
                                                style={{
                                                    width: '100%',
                                                    background: 'rgba(56, 189, 248, 0.05)',
                                                    color: '#fff',
                                                    border: '1px solid rgba(14, 165, 233, 0.4)',
                                                    borderRadius: '10px',
                                                    padding: '12px 15px',
                                                    fontSize: '0.9rem',
                                                    fontWeight: '600',
                                                    outline: 'none',
                                                    appearance: 'none',
                                                    cursor: 'pointer'
                                                }}
                                            >
                                                <option value="" disabled style={{ background: '#0f172a' }}>-- Seleccionar Producto a Analizar --</option>
                                                {uniqueProducts.map(p => (
                                                    <option key={p} value={p} style={{ background: '#0f172a' }}>{p}</option>
                                                ))}
                                            </select>
                                            <ChevronDown size={20} style={{ position: 'absolute', right: '15px', top: '50%', transform: 'translateY(-50%)', color: '#38bdf8', pointerEvents: 'none' }} />
                                        </div>
                                    </div>
                                </div>
                                <div className="chart-btns" style={{ gap: '8px' }}>
                                    <button className="chip-btn" onClick={() => app()?.toggleAbsorbance()} style={{ fontSize: '0.7rem' }}>ADC / ABSORBANCIA</button>
                                    <button className="chip-btn" onClick={() => app()?.clearChart()} style={{ fontSize: '0.7rem' }}>LIMPIAR</button>
                                    <button className="chip-btn" onClick={() => app()?.exportCSV()} style={{ border: '1px solid var(--primary)', color: 'var(--primary)', fontWeight: '900', fontSize: '0.7rem' }}>EXPORTAR CSV</button>
                                </div>
                            </div>
                            <div className="chart-container">
                                <canvas id="nirChart"></canvas>
                            </div>
                        </div>

                        {/* LADO DERECHO: DASHBOARD DE RESULTADOS */}
                        <div className="ind-panel" style={{ flex: 3.5, display: 'flex', flexDirection: 'column', padding: '12px', overflow: 'hidden' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
                                <Zap size={12} style={{ color: '#38bdf8' }} />
                                <span style={{ fontWeight: '900', fontSize: '0.65rem', color: '#fff', letterSpacing: '0.05em' }}>PANTALLA DE RESULTADOS</span>
                            </div>

                            <div className="ind-inset" style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: '10px', overflowY: 'auto' }}>
                                {!selectedModelIds.length ? (
                                    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center' }}>
                                        <Database size={32} style={{ color: 'rgba(56, 189, 248, 0.1)', marginBottom: '8px' }} />
                                        <p style={{ color: 'rgba(255,255,255,0.15)', fontSize: '0.6rem', fontWeight: '900' }}>SELECCIONE MODELO(S)</p>
                                    </div>
                                ) : (
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
                                        {/* Cabecera del Producto */}
                                        <div style={{ paddingBottom: '10px', borderBottom: '1px solid rgba(255,255,255,0.05)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                            <div>
                                                <div style={{ fontSize: '0.6rem', color: '#94a3b8', fontWeight: '800', letterSpacing: '0.05em' }}>MUESTRA(S) SELECCIONADA(S)</div>
                                                <div style={{ fontSize: '1rem', fontWeight: '950', color: '#fff', letterSpacing: '-0.02em' }}>
                                                    {selectedModelIds.length === 1 
                                                        ? models.find(m => m.id === selectedModelIds[0])?.product 
                                                        : 'ANÁLISIS MÚLTIPLE'}
                                                </div>
                                            </div>
                                            <Activity size={16} style={{ color: '#64748b' }} />
                                        </div>

                                        <div className="result-display" style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '10px', minHeight: '30px', position: 'relative' }}>
                                            {isPredicting ? (
                                                <div className="blink" style={{ fontSize: '0.8rem', color: '#00d2ff', fontWeight: '900', letterSpacing: '0.15em', textAlign: 'center', padding: '20px' }}>ANALIZANDO...</div>
                                            ) : predictionResults.length > 0 ? (
                                                predictionResults.map((res, idx) => (
                                                    <div key={idx} style={{ 
                                                        display: 'flex', 
                                                        alignItems: 'center', 
                                                        gap: '15px', 
                                                        padding: '12px', 
                                                        background: 'rgba(56, 189, 248, 0.05)', 
                                                        borderRadius: '12px', 
                                                        border: '1px solid rgba(56, 189, 248, 0.1)' 
                                                    }}>
                                                        <div style={{ padding: '8px', background: 'rgba(56, 189, 248, 0.1)', borderRadius: '10px' }}>
                                                            <Activity size={18} style={{ color: '#38bdf8' }} />
                                                        </div>
                                                        <div style={{ flex: 1 }}>
                                                            <div style={{ fontSize: '0.6rem', color: '#94a3b8', fontWeight: '800' }}>{res.property.toUpperCase()}</div>
                                                            <div style={{ display: 'flex', alignItems: 'baseline', gap: '4px' }}>
                                                                <span style={{ fontSize: '1.4rem', fontWeight: '950', color: '#fff' }}>{res.value.toFixed(1)}</span>
                                                                <span style={{ fontSize: '0.8rem', color: 'rgba(255,255,255,0.5)', fontWeight: '900' }}>%</span>
                                                            </div>
                                                        </div>
                                                        <div style={{ textAlign: 'right' }}>
                                                            <div style={{ fontSize: '0.55rem', color: '#64748b', fontWeight: '900' }}>GH: {res.gh?.toFixed(2)}</div>
                                                            <div style={{ 
                                                                fontSize: '0.55rem', 
                                                                color: res.gh > 3 ? '#fb923c' : '#4ade80', 
                                                                fontWeight: '950',
                                                                letterSpacing: '0.05em'
                                                            }}>
                                                                {res.gh > 3 ? 'OUTLIER' : 'VÁLIDO'}
                                                            </div>
                                                        </div>
                                                    </div>
                                                ))
                                            ) : (
                                                <div style={{ opacity: 0.1, fontSize: '1.5rem', fontWeight: '950', letterSpacing: '0.2em', textAlign: 'center', padding: '20px' }}>ESPERANDO</div>
                                            )}
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>

                    {/* HISTORY PANEL WAS HERE */}
                                <div className="ind-panel mb-15" style={{ height: '220px', display: 'flex', flexDirection: 'column', padding: '12px', marginTop: '15px' }}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                            <Database size={14} style={{ color: '#38bdf8' }} />
                                            <span style={{ color: '#38bdf8', fontWeight: '900', fontSize: '0.6rem', letterSpacing: '0.05em' }}>LOG DE ANÁLISIS RECIENTE</span>
                                        </div>
                                        <div style={{ display: 'flex', gap: '10px' }}>
                                            <button onClick={() => generatePDF(predictionResults)} className="chip-btn" style={{ fontSize: '0.55rem', padding: '2px 8px' }}>
                                                <Printer size={10} style={{ marginRight: '4px' }} /> REPORTE PDF
                                            </button>
                                            <button onClick={() => app()?.clearHistory()} style={{ fontSize: '0.5rem', color: 'rgba(255,255,255,0.2)', fontWeight: '900', background: 'transparent', border: 'none', cursor: 'pointer' }}>LIMPIAR</button>
                                        </div>
                                    </div>
                                    <div id="historyList" className="ind-inset" style={{ flex: 1, overflowY: 'auto', padding: '0px' }}>
                                         {history.length === 0 ? (
                                            <div className="dim-text" style={{fontSize:'.55rem', padding:'15px', color: 'rgba(255,255,255,0.1)', fontWeight: '900', textAlign: 'center' }}>ESPERANDO DATOS...</div>
                                         ) : (
                                            history.map((item, i) => (
                                                <div 
                                                    key={i} 
                                                    onClick={() => setViewedHistoryItem(item)}
                                                    className="history-item"
                                                    style={{ 
                                                        padding: '10px 12px', 
                                                        borderBottom: '1px solid rgba(255,255,255,0.05)', 
                                                        cursor: 'pointer',
                                                        display: 'flex',
                                                        justifyContent: 'space-between',
                                                        alignItems: 'center'
                                                    }}
                                                >
                                                    <div>
                                                        <div style={{ fontSize: '0.7rem', color: '#fff', fontWeight: '900' }}>{item.name}</div>
                                                        <div style={{ fontSize: '0.5rem', color: '#64748b' }}>{new Date(item.time).toLocaleTimeString()}</div>
                                                    </div>
                                                    {item.prediction !== undefined && (
                                                        <div style={{ fontSize: '0.75rem', fontWeight: '950', color: '#38bdf8' }}>{item.prediction.toFixed(1)}%</div>
                                                    )}
                                                </div>
                                            ))
                                         )}
                                    </div>
                                </div>

                                {viewedHistoryItem && (
                                    <div className="ind-panel m-glow-gold" style={{ 
                                        marginTop: '15px', padding: '15px', border: '1px solid #fbbf24', background: 'rgba(251, 191, 36, 0.05)', animation: 'fadeIn 0.3s ease' 
                                    }}>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px' }}>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                                                <div style={{ padding: '8px', background: 'rgba(251, 191, 36, 0.1)', borderRadius: '8px' }}>
                                                    <Clock size={18} style={{ color: '#fbbf24' }} />
                                                </div>
                                                <div>
                                                    <div style={{ fontSize: '0.8rem', fontWeight: '950', color: '#fff' }}>MODO INSPECCIÓN: ANÁLISIS HISTÓRICO</div>
                                                    <div style={{ fontSize: '0.6rem', color: '#fbbf24' }}>{new Date(viewedHistoryItem.time).toLocaleString()}</div>
                                                </div>
                                            </div>
                                            <div style={{ display: 'flex', gap: '8px' }}>
                                                <button onClick={() => generatePDF(viewedHistoryItem)} className="chip-btn" style={{ background: '#fbbf24', color: '#000', border: 'none', fontWeight: '950', display: 'flex', alignItems: 'center', gap: '6px' }}>
                                                    <Printer size={14} /> IMPRIMIR PDF
                                                </button>
                                                <button onClick={() => setViewedHistoryItem(null)} className="chip-btn" style={{ color: '#fff', border: '1px solid rgba(255,255,255,0.1)' }}>CERRAR ×</button>
                                            </div>
                                        </div>
                                    </div>
                                )}
                            </motion.div>
                        )}

                        {activeMenu === 'models' && (
                            <motion.div 
                                key="models"
                                initial={{ opacity: 0, scale: 0.98 }}
                                animate={{ opacity: 1, scale: 1 }}
                                exit={{ opacity: 0, scale: 0.98 }}
                                transition={{ duration: 0.25, ease: "easeOut" }}
                                style={{ height: '100%', overflowY: 'auto', padding: '20px', display: 'flex', flexDirection: 'column', gap: '20px' }}
                            >
                                <div style={{ marginBottom: '10px' }}>
                                    <h2 style={{ fontSize: '1.5rem', fontWeight: '950', color: '#fff' }}>GESTIÓN DE MODELOS</h2>
                                    <p style={{ fontSize: '0.75rem', color: '#38bdf8', fontWeight: '800' }}>Sincronice y administre su librería de modelos predictivos.</p>
                                </div>

                                <div className="ind-panel" style={{ padding: '25px', display: 'flex', flexDirection: 'column', gap: '20px' }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                                        <Cloud size={24} style={{ color: '#38bdf8' }} />
                                        <span style={{ fontWeight: '950', fontSize: '1rem', color: '#fff' }}>MODELOS EN LA NUBE</span>
                                    </div>
                                    
                                    <div className="ind-inset" style={{ padding: '20px', borderRadius: '14px' }}>
                                        <div style={{ fontSize: '0.65rem', color: '#38bdf8', fontWeight: '900', marginBottom: '10px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>LINK NUBE</div>
                                        <div style={{ display: 'flex', gap: '12px' }}>
                                            <input 
                                                type="text" 
                                                value={cloudUrl} 
                                                onChange={(e) => setCloudUrl(e.target.value)} 
                                                placeholder="https://script.google.com/macros/s/..." 
                                                style={{ flex: 1, background: 'rgba(0,0,0,0.3)', color: '#fff', border: '1px solid rgba(14, 165, 233, 0.3)', borderRadius: '10px', padding: '14px', fontSize: '0.8rem' }} 
                                            />
                                            <button 
                                                onClick={syncLibrary} 
                                                disabled={isSyncing} 
                                                className="btn-action" 
                                                style={{ width: '52px', height: '52px', padding: 0 }}
                                            >
                                                <RefreshCw size={24} className={isSyncing ? "spin" : ""} />
                                            </button>
                                        </div>
                                        
                                        {cloudFolders.length > 0 && (
                                            <div style={{ marginTop: '20px', animation: 'fadeIn 0.3s' }}>
                                                <div style={{ fontSize: '0.65rem', color: '#38bdf8', fontWeight: '900', marginBottom: '10px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>SELECCIONAR MATERIA PRIMA</div>
                                                <div style={{ position: 'relative' }}>
                                                    <select 
                                                        value={selectedFolder}
                                                        onChange={(e) => loadFolderModels(e.target.value)}
                                                        style={{ width: '100%', background: 'rgba(56, 189, 248, 0.05)', color: '#fff', border: '1px solid rgba(14, 165, 233, 0.4)', borderRadius: '10px', padding: '12px 15px', fontSize: '0.85rem', outline: 'none', appearance: 'none' }}
                                                    >
                                                        <option value="">-- Seleccionar Carpeta de Modelos --</option>
                                                        {cloudFolders.map(f => <option key={f.id} value={f.id} style={{ background: '#0f172a' }}>{f.name}</option>)}
                                                    </select>
                                                    <ChevronDown size={18} style={{ position: 'absolute', right: '15px', top: '50%', transform: 'translateY(-50%)', color: '#38bdf8', pointerEvents: 'none' }} />
                                                </div>
                                            </div>
                                        )}
                                    </div>

                                    <div className="ind-inset" style={{ padding: '20px', borderRadius: '14px', marginTop: '10px' }}>
                                        <div style={{ fontSize: '0.65rem', color: '#38bdf8', fontWeight: '900', marginBottom: '10px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>CARGAR MODELO LOCAL</div>
                                        <div style={{ display: 'flex', alignItems: 'center' }}>
                                            <label style={{ cursor: 'pointer', background: 'rgba(14, 165, 233, 0.15)', color: '#38bdf8', border: '1px solid rgba(14, 165, 233, 0.4)', borderRadius: '10px', padding: '12px 20px', fontSize: '0.8rem', fontWeight: '800', display: 'flex', alignItems: 'center', gap: '8px', transition: 'all 0.2s' }}>
                                                <FileJson size={18} /> Buscar archivo JSON
                                                <input type="file" accept=".json" onChange={loadLocalModel} style={{ display: 'none' }} />
                                            </label>
                                        </div>
                                    </div>

                                    <div style={{ marginTop: '10px' }}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '15px' }}>
                                            <Database size={18} style={{ color: '#38bdf8' }} />
                                            <span style={{ fontWeight: '950', fontSize: '0.85rem', color: '#fff' }}>LIBRERÍA LOCAL DE MODELOS</span>
                                            <span style={{ fontSize: '0.6rem', color: '#94a3b8', marginLeft: 'auto' }}>({models.length} modelos cargados)</span>
                                        </div>

                                        <div className="ind-inset" style={{ minHeight: '300px', padding: '15px', overflowY: 'auto' }}>
                                            {models.length === 0 ? (
                                                <div style={{ height: '200px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: 'rgba(255,255,255,0.15)', gap: '15px' }}>
                                                    <Database size={48} />
                                                    <span style={{ fontSize: '0.8rem', fontWeight: '900', letterSpacing: '0.1em' }}>SIN MODELOS DISPONIBLES</span>
                                                    <button onClick={syncLibrary} className="chip-btn" style={{ fontSize: '0.7rem' }}>SINCRONIZAR AHORA</button>
                                                </div>
                                            ) : (
                                                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '12px' }}>
                                                    {models.map(m => (
                                                        <div key={m.id} className={`model-card ${selectedModelIds.includes(m.id) ? 'selected' : ''}`} style={{ 
                                                            display: 'flex', 
                                                            alignItems: 'center', 
                                                            justifyContent: 'space-between', 
                                                            padding: '15px', 
                                                            background: selectedModelIds.includes(m.id) ? 'rgba(56, 189, 248, 0.08)' : 'rgba(255,255,255,0.02)', 
                                                            borderRadius: '12px', 
                                                            border: '1px solid',
                                                            borderColor: selectedModelIds.includes(m.id) ? 'rgba(56, 189, 248, 0.4)' : 'rgba(255,255,255,0.05)',
                                                            transition: 'all 0.2s'
                                                        }}>
                                                            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flex: 1 }}>
                                                                <div 
                                                                    onClick={() => setSelectedModelIds(prev => prev.includes(m.id) ? prev.filter(id => id !== m.id) : [...prev, m.id])}
                                                                    style={{ 
                                                                        width: '20px', 
                                                                        height: '20px', 
                                                                        borderRadius: '6px', 
                                                                        border: '2px solid',
                                                                        borderColor: selectedModelIds.includes(m.id) ? '#38bdf8' : 'rgba(255,255,255,0.2)',
                                                                        background: selectedModelIds.includes(m.id) ? '#38bdf8' : 'transparent',
                                                                        display: 'flex',
                                                                        alignItems: 'center',
                                                                        justifyContent: 'center',
                                                                        cursor: 'pointer'
                                                                    }}
                                                                >
                                                                    {selectedModelIds.includes(m.id) && <Plus size={14} style={{ color: '#000', transform: 'rotate(45deg)' }} />}
                                                                </div>
                                                                <div style={{ flex: 1, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '8px' }} onClick={() => setSelectedModelIds(prev => prev.includes(m.id) ? prev.filter(id => id !== m.id) : [...prev, m.id])}>
                                                                    <div style={{ padding: '6px', background: 'rgba(56, 189, 248, 0.1)', borderRadius: '8px', display: 'flex' }}>
                                                                        {getProductIcon(m.product)}
                                                                    </div>
                                                                    <div>
                                                                        <div style={{ fontSize: '0.85rem', fontWeight: '950', color: '#fff', letterSpacing: '-0.01em' }}>{m.product}</div>
                                                                        <div style={{ fontSize: '0.65rem', color: '#94a3b8', fontWeight: '700' }}>{m.name}</div>
                                                                    </div>
                                                                </div>
                                                            </div>
                                                            <div style={{ display: 'flex', gap: '8px' }}>
                                                                <button 
                                                                    onClick={(e) => {
                                                                        e.stopPropagation();
                                                                        const devKey = appRef.current?.getDeviceKey() || '';
                                                                        const modelKey = `${devKey}_${m.product}`;
                                                                        const settings = appRef.current?.biasSettings[modelKey] || {};
                                                                        setBiasTargetModel(m);
                                                                        setBiasState(settings);
                                                                        setIsBiasModalOpen(true);
                                                                    }}
                                                                    title="Ajuste de Bias/Slope"
                                                                    className="btn-icon-gold"
                                                                    style={{ padding: '8px', background: 'rgba(251, 191, 36, 0.1)', border: '1px solid rgba(251, 191, 36, 0.2)', borderRadius: '8px', color: '#fbbf24' }}
                                                                >
                                                                    <Settings size={14} />
                                                                </button>
                                                                <button 
                                                                    onClick={(e) => {
                                                                        e.stopPropagation();
                                                                        if (window.confirm(`¿Eliminar modelo ${m.product}?`)) {
                                                                            setModels(prev => prev.filter(x => x.id !== m.id));
                                                                        }
                                                                    }}
                                                                    className="btn-icon-red"
                                                                    style={{ padding: '8px', background: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.2)', borderRadius: '8px', color: '#ef4444' }}
                                                                >
                                                                    <Trash2 size={14} />
                                                                </button>
                                                            </div>
                                                        </div>
                                                    ))}
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            </motion.div>
                        )}

                        {activeMenu === 'config' && (
                            <motion.div 
                                key="config"
                                initial={{ opacity: 0, scale: 0.98 }}
                                animate={{ opacity: 1, scale: 1 }}
                                exit={{ opacity: 0, scale: 0.98 }}
                                transition={{ duration: 0.25, ease: "easeOut" }}
                                style={{ height: '100%', overflowY: 'auto', padding: '20px', display: 'flex', flexDirection: 'column', gap: '20px' }}
                            >
                                <div style={{ marginBottom: '10px' }}>
                                    <h2 style={{ fontSize: '1.5rem', fontWeight: '950', color: '#fff' }}>PANEL DE CONFIGURACIÓN</h2>
                                    <p style={{ fontSize: '0.75rem', color: '#38bdf8', fontWeight: '800' }}>Gestione la conectividad y modelos predictivos.</p>
                                </div>
                                <div style={{ display: 'grid', gridTemplateColumns: 'minmax(350px, 1fr)', gap: '20px' }}>
                                    <div className="ind-panel" style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '15px' }}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                                            <Bluetooth size={20} style={{ color: '#38bdf8' }} />
                                            <span style={{ fontWeight: '950', fontSize: '0.85rem', color: '#fff' }}>SISTEMA DE CONEXIÓN</span>
                                        </div>
                                        <button className="btn-action" onClick={() => app()?.connect()} style={{ width: '100%', padding: '18px', borderRadius: '14px', fontWeight: '950', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '12px' }}>
                                             <Search size={20} /> VINCULAR EQUIPO MICRO-NIR
                                        </button>
                                        <div className="ind-inset" style={{ padding: '15px' }}>
                                            <div style={{ fontSize: '0.6rem', color: '#38bdf8', fontWeight: '900', marginBottom: '8px' }}>MÉTODO DE COMUNICACIÓN</div>
                                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '15px' }}>
                                                <button onClick={() => app()?.setMode('ble')} className="chip-btn" style={{ background: 'rgba(56, 189, 248, 0.1)', borderColor: '#38bdf8', color: '#fff' }}>BLUETOOTH LE</button>
                                                <button onClick={() => app()?.setMode('usb')} className="chip-btn">USB / SERIAL</button>
                                            </div>
                                            <div style={{ fontSize: '0.6rem', color: '#38bdf8', fontWeight: '900', marginBottom: '5px' }}>UUID DE SERVICIO PERSONALIZADO (UART)</div>
                                            <input 
                                                type="text" 
                                                value={customUuid} 
                                                onChange={(e) => setCustomUuid(e.target.value)} 
                                                placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" 
                                                style={{ width: '100%', background: 'rgba(0,0,0,0.3)', color: '#fff', border: '1px solid rgba(14, 165, 233, 0.3)', borderRadius: '8px', padding: '10px', fontSize: '0.7rem', fontFamily: 'var(--mono)' }} 
                                            />
                                        </div>
                                    </div>
                                </div>
                            </motion.div>
                        )}

                        {activeMenu === 'diag' && (
                            <motion.div 
                                key="diag"
                                initial={{ opacity: 0, scale: 0.98 }}
                                animate={{ opacity: 1, scale: 1 }}
                                exit={{ opacity: 0, scale: 0.98 }}
                                transition={{ duration: 0.25, ease: "easeOut" }}
                                style={{ height: '100%', overflowY: 'auto', padding: '20px', display: 'flex', flexDirection: 'column', gap: '20px' }}
                            >
                                <div style={{ marginBottom: '10px' }}>
                                    <h2 style={{ fontSize: '1.5rem', fontWeight: '950', color: '#fff' }}>SISTEMA DE DIAGNÓSTICO</h2>
                                    <p style={{ fontSize: '0.75rem', color: '#38bdf8', fontWeight: '800' }}>Verificación técnica y telemetría de hardware.</p>
                                </div>

                                <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: '25px', flex: 1 }}>
                                    <div className="ind-panel" style={{ padding: '20px' }}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '20px' }}>
                                            <Activity size={18} style={{ color: '#38bdf8' }} />
                                            <span style={{ fontWeight: '950', fontSize: '0.8rem', color: '#fff' }}>ESTADO DE HARDWARE</span>
                                        </div>
                                        <div style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
                                            {[
                                                { label: 'PROCESADOR (MCU)', id: 'mcu' },
                                                { label: 'LÁMPARA (ENG)', id: 'lamp' },
                                                { label: 'CONVERSOR (ADC)', id: 'adc' },
                                                { label: 'ALIMENTACIÓN (PWR)', id: 'pwr' }
                                            ].map(led => (
                                                <div key={led.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px', background: 'rgba(255,255,255,0.02)', borderRadius: '10px', border: '1px solid rgba(255,255,255,0.05)' }}>
                                                    <span style={{ fontSize: '0.65rem', fontWeight: '900', color: '#cbd5e1' }}>{led.label}</span>
                                                    <div id={`diag-led-${led.id}`} className={`status-led ${hwStatus[led.id] ? 'led-on' : 'led-off'}`}></div>
                                                </div>
                                            ))}
                                        </div>
                                    </div>

                                    <div className="ind-panel" style={{ padding: '20px', display: 'flex', flexDirection: 'column' }}>
                                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '15px' }}>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                                <LayoutList size={18} style={{ color: '#38bdf8' }} />
                                                <span style={{ fontWeight: '950', fontSize: '0.8rem', color: '#fff' }}>CONSOLA DEL SISTEMA</span>
                                            </div>
                                            <div style={{ fontSize: '0.55rem', color: '#38bdf8', fontWeight: '900', background: 'rgba(56, 189, 248, 0.1)', padding: '4px 10px', borderRadius: '4px' }}>LOGS EN TIEMPO REAL</div>
                                        </div>
                                        <div className="ind-inset" style={{ flex: 1, padding: '15px', overflowY: 'auto', background: '#020617', borderRadius: '15px' }}>
                                            <div id="diagConsole" style={{ fontSize: '0.75rem', fontFamily: 'var(--mono)', color: 'rgba(56, 189, 248, 0.6)', lineHeight: '1.6' }}>
                                                {diagLogs.length === 0 ? (
                                                    <div>{'>'} Preparando consola de diagnóstico...</div>
                                                ) : (
                                                    diagLogs.map(log => (
                                                        <div key={log.id} style={{ 
                                                            marginBottom: '2px', 
                                                            color: log.type === 'log-err' ? '#ef4444' : log.type === 'log-warn' ? '#fb923c' : 'rgba(56, 189, 248, 0.6)' 
                                                        }}>
                                                            [{log.time}] {log.msg}
                                                        </div>
                                                    ))
                                                )}
                                                <div ref={logEndRef} />
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            </motion.div>
                        )}
                    </AnimatePresence>
                </main>

            </div>

            {/* MODAL: BIAS Y SLOPE CORRECTION */}
            {isBiasModalOpen && biasTargetModel && (
                <div style={{
                    position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
                    background: 'rgba(0,0,0,0.85)', backdropFilter: 'blur(10px)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    zIndex: 2000, padding: '20px'
                }}>
                    <div className="ind-panel" style={{ width: '100%', maxWidth: '400px', padding: '25px', boxShadow: '0 0 50px rgba(0,0,0,0.5)', border: '1px solid rgba(14, 165, 233, 0.4)' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
                            <div>
                                <div style={{ fontSize: '1rem', fontWeight: '950', color: '#fff', letterSpacing: '-0.02em' }}>CORRECCIÓN BIAS/SLOPE</div>
                                <div style={{ fontSize: '0.6rem', color: '#0ea5e9', fontWeight: '800' }}>MODELO: {biasTargetModel.product}</div>
                            </div>
                            <Activity size={24} style={{ color: '#0ea5e9', opacity: 0.5 }} />
                        </div>

                        <div className="ind-inset" style={{ padding: '15px', maxHeight: '400px', overflowY: 'auto', marginBottom: '20px', display: 'flex', flexDirection: 'column', gap: '20px' }}>
                            {/* Buscar todos los modelos que pertenecen al mismo producto */}
                            {models.filter(m => m.product === biasTargetModel.product).map(m => {
                                const prop = m.json?.analyticalProperty || m.name;
                                const settings = biasState[prop] || { bias: 0, slope: 1 };

                                return (
                                    <div key={m.id} style={{ paddingBottom: '15px', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                                        <div style={{ fontSize: '0.75rem', fontWeight: '900', color: '#fff', marginBottom: '10px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                                            <div style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#0ea5e9' }}></div>
                                            {prop.toUpperCase()}
                                        </div>
                                        
                                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px' }}>
                                            <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
                                                <label style={{ fontSize: '0.55rem', color: '#94a3b8', fontWeight: '800' }}>BIAS (SESGO)</label>
                                                <input 
                                                    type="number" 
                                                    step="0.001"
                                                    value={settings.bias}
                                                    onChange={(e) => {
                                                        const val = parseFloat(e.target.value);
                                                        setBiasState(prev => ({
                                                            ...prev,
                                                            [prop]: { ...settings, bias: isNaN(val) ? 0 : val }
                                                        }));
                                                    }}
                                                    style={{ background: '#050a14', color: '#fff', border: '1px solid rgba(14, 165, 233, 0.3)', borderRadius: '6px', padding: '8px', fontSize: '0.8rem', fontFamily: 'var(--mono)', fontWeight: '900', outline: 'none' }}
                                                />
                                            </div>
                                            <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
                                                <label style={{ fontSize: '0.55rem', color: '#94a3b8', fontWeight: '800' }}>SLOPE (PENDIENTE)</label>
                                                <input 
                                                    type="number" 
                                                    step="0.001"
                                                    value={settings.slope}
                                                    onChange={(e) => {
                                                        const val = parseFloat(e.target.value);
                                                        setBiasState(prev => ({
                                                            ...prev,
                                                            [prop]: { ...settings, slope: isNaN(val) ? 1 : val }
                                                        }));
                                                    }}
                                                    style={{ background: '#050a14', color: '#fff', border: '1px solid rgba(14, 165, 233, 0.3)', borderRadius: '6px', padding: '8px', fontSize: '0.8rem', fontFamily: 'var(--mono)', fontWeight: '900', outline: 'none' }}
                                                />
                                            </div>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>

                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                            <button 
                                onClick={() => setIsBiasModalOpen(false)}
                                style={{ padding: '12px', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', color: '#94a3b8', borderRadius: '8px', fontWeight: '950', fontSize: '0.75rem', cursor: 'pointer' }}
                            >
                                CANCELAR
                            </button>
                            <button 
                                onClick={() => {
                                    app()?.saveBiasSettings(biasTargetModel.product, biasState);
                                    setIsBiasModalOpen(false);
                                }}
                                style={{ padding: '12px', background: '#0ea5e9', border: 'none', color: '#000', borderRadius: '8px', fontWeight: '950', fontSize: '0.75rem', cursor: 'pointer', boxShadow: '0 4px 15px rgba(14, 165, 233, 0.4)' }}
                            >
                                GUARDAR AJUSTES
                            </button>
                        </div>
                        <div style={{ marginTop: '15px', textAlign: 'center', fontSize: '0.5rem', color: 'rgba(14, 165, 233, 0.5)', fontWeight: '700' }}>
                            EQUIPO: {app()?.getDeviceKey()} | Matriz: {biasTargetModel.product}
                        </div>
                    </div>
                </div>
            )}

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
                        <button className="btn" id="btnUUIDOk" style={{ background: 'linear-gradient(135deg, #22c55e 0%, #16a34a 100%)', color: '#fff' }}>Confirmar y Reconectar</button>
                        <button className="btn btn-ghost-red" id="btnUUIDCancel">Cancelar</button>
                    </div>
                </div>
            </div>
        </>
    );
}
