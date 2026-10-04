/* Classroom Game SDK 1.0.0. Copy unchanged into each game. */
(function (global) {
  'use strict';
  const specs = {gameReady:['gameId','version'],submitAnswer:['playerId','questionId','answer','isCorrect','timeMs'],updateScore:['playerId','score','delta'],gameEnd:['roomCode','leaderboard']};
  const exact = (o, keys) => o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).length === keys.length && keys.every(k => Object.hasOwn(o,k));
  function validate(m, direction) {
    if (!m || typeof m !== 'object') return false;
    if (direction === 'host') return ['startGame','endGame'].includes(m.type) ? exact(m,['type']) : m.type === 'loadContent' && exact(m,['type','payload']) && exact(m.payload,['questions']) && Array.isArray(m.payload.questions);
    const keys = specs[m.type];
    if (!keys || !exact(m,['type','payload']) || !exact(m.payload,keys)) return false;
    const p=m.payload;
    if (m.type==='gameReady') return typeof p.gameId==='string' && typeof p.version==='string';
    if (m.type==='submitAnswer') return typeof p.playerId==='string' && typeof p.questionId==='string' && typeof p.isCorrect==='boolean' && Number.isFinite(p.timeMs) && p.timeMs>=0;
    if (m.type==='updateScore') return typeof p.playerId==='string' && Number.isFinite(p.score) && Number.isFinite(p.delta);
    return typeof p.roomCode==='string' && Array.isArray(p.leaderboard) && p.leaderboard.every(r=>exact(r,['playerId','name','score','rank']) && typeof r.playerId==='string' && typeof r.name==='string' && Number.isFinite(r.score) && Number.isInteger(r.rank) && r.rank>0);
  }
  function create({parentOrigin}) {
    if (typeof parentOrigin!=='string' || !/^https?:\/\//.test(parentOrigin) || new URL(parentOrigin).origin!==parentOrigin) throw new TypeError('Use an exact HTTP(S) parent origin');
    const handlers=new Set();
    const receive=e=>{if(e.source===global.parent && e.origin===parentOrigin && validate(e.data,'host')) handlers.forEach(h=>h(e.data));};
    global.addEventListener('message',receive);
    return Object.freeze({send(m){if(!validate(m,'game')) throw new TypeError('Invalid SDK event'); global.parent.postMessage(m,parentOrigin);},onMessage(h){if(typeof h!=='function') throw new TypeError('Expected handler');handlers.add(h);return ()=>handlers.delete(h);},destroy(){handlers.clear();global.removeEventListener('message',receive);}});
  }
  global.ClassroomGameSDK=Object.freeze({VERSION:'1.0.0',create,validateGameToHost:m=>validate(m,'game'),validateHostToGame:m=>validate(m,'host')});
})(window);
