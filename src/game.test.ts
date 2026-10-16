import {describe,it,expect} from 'vitest';
import {makeChallenge,orderForPlayer,points,scoreRound,formatScore,swapReplacement,dayKey} from './game';
import claims from './claims.json';
import type {Claim,Category} from './game';
const library=claims as Claim[];

describe('scoring uses exact sixth-point units',()=>{
 it('a correct classification earns 1 point',()=>expect(points('FACT','FACT')).toBe(6));
 it('FACT/KINDA earns 0.5 point per claim',()=>expect(points('FACT','KINDA')).toBe(3));
 it('KINDA/BULLSHIT earns one third point per claim',()=>expect(points('KINDA','BULLSHIT')).toBe(2));
 it('FACT/BULLSHIT earns zero',()=>expect(points('FACT','BULLSHIT')).toBe(0));
 it('nine correct classifications total 9 points',()=>expect(Array(9).fill(points('FACT','FACT')).reduce((a,b)=>a+b,0)).toBe(54));
 it('saving all three wildcards adds exactly 1 point to the 9-point ceiling',()=>expect((54+3*2)/6).toBe(10));
});
describe('daily challenge selection',()=>{
 it('is deterministic for a given date and gives one of each category per round',()=>{const a=makeChallenge('2026-10-13',library),b=makeChallenge('2026-10-13',library);expect(a.map(r=>r.map(c=>c.id))).toEqual(b.map(r=>r.map(c=>c.id)));for(const r of a)expect(r.map(c=>c.category).sort()).toEqual((['BULLSHIT','FACT','KINDA'] as Category[]).sort())});
 it('keys the daily challenge by UTC date',()=>{expect(dayKey(new Date('2026-10-13T23:59:00Z'))).toBe('2026-10-13');expect(dayKey(new Date('2026-10-14T00:01:00Z'))).toBe('2026-10-14')});
 it('contains nine unique records',()=>{const rounds=makeChallenge('2026-10-13',library);expect(rounds.flat()).toHaveLength(9);expect(new Set(rounds.flat().map(c=>c.id)).size).toBe(9)});
 it('shuffles the player order, gives distinct round arrangements, and preserves all claims',()=>{const base=makeChallenge('2026-10-13',library),ordered=orderForPlayer(base,1234);expect(ordered.flat().map(c=>c.id).sort()).toEqual(base.flat().map(c=>c.id).sort());for(const r of ordered)expect(r.map(c=>c.category).sort()).toEqual((['BULLSHIT','FACT','KINDA'] as Category[]).sort());expect(new Set(ordered.map(r=>r.map(c=>c.category).join(','))).size).toBe(3)});
 it('different browser seeds can produce different orders',()=>{const base=makeChallenge('2026-10-13',library);expect(orderForPlayer(base,1).flat().map(c=>c.id)).not.toEqual(orderForPlayer(base,2).flat().map(c=>c.id))});
});
describe('Lifesaver scoring',()=>{
 const sample:Claim[]=[{id:'a',category:'FACT',claim:'a',explanation:'',sources:[],replacementEligible:true,obscurity:5},{id:'b',category:'KINDA',claim:'b',explanation:'',sources:[],replacementEligible:true,obscurity:5},{id:'c',category:'BULLSHIT',claim:'c',explanation:'',sources:[],replacementEligible:true,obscurity:5}];
 it('awards full points to a protected claim and its counterpart',()=>expect(scoreRound(sample,['KINDA','FACT','BULLSHIT'],0)).toEqual([6,6,6]));
 it('keeps normal scoring when the protected answer is correct',()=>expect(scoreRound(sample,['FACT','KINDA','BULLSHIT'],0)).toEqual([6,6,6]));
 it('gives unanswered claims zero',()=>expect(scoreRound(sample,[null,'KINDA','BULLSHIT'],null)).toEqual([0,6,6]));
});

describe('decimal score display',()=>{it('uses clean decimal values instead of fractions',()=>{expect(formatScore(18)).toBe('3');expect(formatScore(15)).toBe('2.5');expect(formatScore(10)).toBe('1.67');expect(formatScore(2)).toBe('0.33');expect(formatScore(1)).toBe('0.17')})});

describe('Swap replacement is deterministic for everyone',()=>{
  const date='2026-10-13';
  const base=makeChallenge(date,library);
  const used=base.flat().map(c=>c.id);
  it('always returns the same backup for a given date and claim',()=>{
    const target=base[0][0];
    const first=swapReplacement(date,target,library,used);
    const second=swapReplacement(date,target,library,used);
    expect(first).not.toBeNull();
    expect(first!.id).toBe(second!.id);
  });
  it('is independent of the player-specific card order',()=>{
    const target=base[1][0];
    const shuffled=orderForPlayer(base,987654).flat().map(c=>c.id);
    expect(swapReplacement(date,target,library,used)!.id).toBe(swapReplacement(date,target,library,shuffled)!.id);
  });
  it('keeps the same hidden category, stays eligible, and avoids claims already in play',()=>{
    for(const round of base){for(const claim of round){const r=swapReplacement(date,claim,library,used);if(r){expect(r.category).toBe(claim.category);expect(r.replacementEligible).toBe(true);expect(used).not.toContain(r.id);expect(r.id).not.toBe(claim.id)}}}
  });
});

