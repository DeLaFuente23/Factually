export type Category = 'FACT'|'KINDA'|'BULLSHIT';
export type Claim = {id:string;category:Category;claim:string;explanation:string;sources:{title:string;url:string}[];replacementEligible:boolean;tags?:string[]};
export const labels:Category[]=['FACT','KINDA','BULLSHIT'];
export function dayKey(date=new Date()):string{return date.toISOString().slice(0,10)}
function hash(s:string){let h=2166136261;for(const c of s)h=Math.imul(h^c.charCodeAt(0),16777619);return h>>>0}
export function makeChallenge(date:string,library:Claim[]):Claim[][] {const categories:Category[]=['FACT','KINDA','BULLSHIT'];const chosen=new Set<string>();return [0,1,2].map(round=>categories.map(cat=>{const options=library.filter(c=>c.category===cat);let seed=hash(`${date}:${round}:${cat}`);let pick=options[seed%options.length];for(let i=0;i<options.length&&chosen.has(pick.id);i++)pick=options[(seed+i+1)%options.length];chosen.add(pick.id);return pick;}));}
export function points(selected:Category,actual:Category):number {if(selected===actual)return 6;const gap=Math.abs(labels.indexOf(selected)-labels.indexOf(actual));return gap===1?(selected==='FACT'||actual==='FACT'?3:2):0;}



