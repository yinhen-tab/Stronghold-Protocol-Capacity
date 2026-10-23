import { validateC2S, C2S } from './shared/protocol.js';
import { MAX_SEATS } from './shared/constants.js';

console.log('MAX_SEATS =', MAX_SEATS);
console.log('C2S 有 room.removeBot:', Object.hasOwn(C2S, 'room.removeBot'));
console.log('removeBot 规则:', JSON.stringify(C2S['room.removeBot']));
console.log('validateC2S({seat:20}) =', JSON.stringify(validateC2S({ t: 'room.removeBot', seat: MAX_SEATS })));
console.log('validateC2S({seat:19}) =', JSON.stringify(validateC2S({ t: 'room.removeBot', seat: MAX_SEATS - 1 })));
console.log('validateC2S({seat:0})  =', JSON.stringify(validateC2S({ t: 'room.removeBot', seat: 0 })));
console.log('validateC2S(room.create capacity 20) =', JSON.stringify(validateC2S({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL', capacity: 20 })));
