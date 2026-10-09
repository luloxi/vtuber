export type BaseId = 'gally' | 'woman' | 'man';
export type PartId =
  | 'catEars' | 'catTail' | 'whiskers'
  | 'foxEars' | 'foxTail' | 'foxMuzzle'
  | 'bunnyEars' | 'bunnyTail' | 'bunnyNose'
  | 'wolfEars' | 'wolfTail' | 'wolfMuzzle'
  | 'antennae' | 'antennaGlow' | 'elfEars';

export interface CharacterDef {
  id: string;
  label: string;
  emoji: string;
  base: BaseId;
  /** Skin or fur tint applied to face and body skin. null keeps the model's own skin. */
  skin: string | null;
  parts: PartId[];
  /** Colour used for ears and tails ('hair' follows the hair colour). */
  partColor: string | 'hair';
  defaults: { hair: string; hairColor: string; outfit: string };
}

export const CHARACTERS: CharacterDef[] = [
  { id: 'gally', label: 'Gally (Alita-inspired)', emoji: '🤖', base: 'gally', skin: null, parts: [], partColor: 'hair',
    defaults: { hair: 'bob', hairColor: 'black', outfit: 'original' } },
  { id: 'woman', label: 'Woman', emoji: '👩', base: 'woman', skin: null, parts: [], partColor: 'hair',
    defaults: { hair: 'long', hairColor: 'brown', outfit: 'original' } },
  { id: 'man', label: 'Man', emoji: '👨', base: 'man', skin: null, parts: [], partColor: 'hair',
    defaults: { hair: 'short', hairColor: 'black', outfit: 'original' } },
  { id: 'green-alien', label: 'Green alien', emoji: '👽', base: 'man', skin: '#a6dc8f', parts: ['antennae'], partColor: '#5fb44c',
    defaults: { hair: 'swept', hairColor: 'silver', outfit: 'cyber' } },
  { id: 'blue-alien', label: 'Blue alien', emoji: '🧞', base: 'woman', skin: '#a9c6f7', parts: ['elfEars', 'antennaGlow'], partColor: '#6c9cf0',
    defaults: { hair: 'fluffy', hairColor: 'silver', outfit: 'cyber' } },
  { id: 'cat', label: 'Cat', emoji: '🐱', base: 'woman', skin: null, parts: ['catEars', 'catTail', 'whiskers'], partColor: 'hair',
    defaults: { hair: 'bob', hairColor: 'black', outfit: 'hoodie' } },
  { id: 'furry', label: 'Furry (wolf)', emoji: '🐺', base: 'man', skin: '#cbbcae', parts: ['wolfEars', 'wolfTail', 'wolfMuzzle'], partColor: '#8a7b6e',
    defaults: { hair: 'swept', hairColor: 'silver', outfit: 'hoodie' } },
  { id: 'fox', label: 'Fox (Zootopia-inspired)', emoji: '🦊', base: 'man', skin: '#eaa36a', parts: ['foxEars', 'foxTail', 'foxMuzzle'], partColor: '#e07a32',
    defaults: { hair: 'short', hairColor: 'ginger', outfit: 'shirt-tie' } },
  { id: 'bunny', label: 'Bunny (Zootopia-inspired)', emoji: '🐰', base: 'woman', skin: '#d9d6df', parts: ['bunnyEars', 'bunnyTail', 'bunnyNose'], partColor: '#a9a5b3',
    defaults: { hair: 'bob', hairColor: 'silver', outfit: 'officer' } },
];

export const HAIRSTYLES = [
  { id: 'bob', label: 'Bob' },
  { id: 'long', label: 'Long straight' },
  { id: 'short', label: 'Short messy' },
  { id: 'swept', label: 'Swept spiky' },
  { id: 'fluffy', label: 'Fluffy long' },
];

export const HAIR_COLORS = [
  { id: 'black', label: 'Black', hex: '#2a2220' },
  { id: 'brown', label: 'Brown', hex: '#7a4a2c' },
  { id: 'blonde', label: 'Blonde', hex: '#f0cf7a' },
  { id: 'ginger', label: 'Ginger', hex: '#e06a28' },
  { id: 'silver', label: 'Silver', hex: '#c9ccd6' },
];

export interface OutfitDef { id: string; label: string; tint: string | null; glow?: string; accessory?: 'tie' | 'badge' }
export const OUTFITS: OutfitDef[] = [
  { id: 'original', label: 'Original', tint: null },
  { id: 'cyber', label: 'Cyber suit', tint: '#3a4250', glow: '#46e0ff' },
  { id: 'shirt-tie', label: 'Green shirt & tie', tint: '#6fae6a', accessory: 'tie' },
  { id: 'officer', label: 'Officer blue', tint: '#3d4f9a', accessory: 'badge' },
  { id: 'hoodie', label: 'Red casual', tint: '#d0473f' },
];

export const BASE_URLS: Record<BaseId, string> = {
  gally: '/models/gally.vrm',
  woman: '/models/woman.vrm',
  man: '/models/man.vrm',
};

export interface Config { character: string; hair: string; hairColor: string; outfit: string }
export const charById = (id: string) => CHARACTERS.find((c) => c.id === id) ?? CHARACTERS[0];
