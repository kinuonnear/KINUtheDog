// Node globals expected by the NEAR wallet-selector packages.
// Imported first in main.jsx so it runs before any wallet module.
import { Buffer } from 'buffer';
import process from 'process';

globalThis.Buffer ??= Buffer;
globalThis.process ??= process;
