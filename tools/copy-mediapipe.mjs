// Copies the MediaPipe Tasks Vision wasm runtime into public/ so it is self-hosted.
import { cpSync, mkdirSync } from 'node:fs';
mkdirSync('public/mediapipe/wasm', { recursive: true });
cpSync('node_modules/@mediapipe/tasks-vision/wasm', 'public/mediapipe/wasm', { recursive: true });
console.log('Copied MediaPipe wasm to public/mediapipe/wasm');
