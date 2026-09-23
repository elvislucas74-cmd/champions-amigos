import express from 'express';
import crypto from 'crypto';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import { readDb, writeDb, id } from './db.js';
import { auth, adminOnly, signUser } from './auth.js';

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));
const PORT = process.env.PORT || 4000;
const now = () => new Date().toISOString();

const FORMATS = {
  league: { label: 'Liga', phases: ['league'] },
  league_knockout: { label: 'Liga + Mata-mata', phases: ['league', 'quarterfinal', 'semifinal', 'final'] },
  groups_knockout: { label: 'Grupos + Mata-mata', phases: ['groups', 'quarterfinal', 'semifinal', 'final'] },
  knockout: { label: 'Mata-mata', phases: ['round_of_16', 'quarterfinal', 'semifinal', 'final'] }
};
const PHASE_LABELS = { league:'Liga', groups:'Fase de grupos', round_of_16:'Oitavas de final', quarterfinal:'Quartas de final', semifinal:'Semifinais', final:'Final' };

function cleanUser(u) { if (!u) return null; const { passwordHash, recoveryKeyHash, ...safe } = u; return safe; }
function championship(db, cid) { return db.championships.find(c => c.id === cid); }
function team(db, tid) { return db.teams.find(t => t.id === tid); }
function teamName(db, tid) { return team(db, tid)?.name || 'Desconhecido'; }
function publicTeam(db, t) { if (!t) return null; const p = db.players.find(x => x.id === t.playerId); return { ...t, player: p ? { id:p.id, name:p.name, displayName:p.displayName } : null }; }
function publicMatch(db, m) { return { ...m, homeTeam: publicTeam(db, team(db,m.homeTeamId)), awayTeam: publicTeam(db, team(db,m.awayTeamId)) }; }
function validPassword(v) { return typeof v === 'string' && v.length >= 8 && /[A-Z]/.test(v) && /[a-z]/.test(v) && /\d/.test(v); }
function validUsername(v) { return typeof v === 'string' && /^[A-Za-z0-9._-]{4,30}$/.test(v); }
function recoveryKey() { return crypto.randomBytes(9).toString('base64url').slice(0,12).toUpperCase(); }
function registrationToken() { return crypto.randomBytes(18).toString('base64url'); }
function adminPublic(db) { const a = db.users.find(u=>u.role==='admin'); return { name:a?.displayName||a?.name||'Administrador' }; }
function notification(db, data) { db.notifications.unshift({ id:id('not'), read:false, createdAt:now(), ...data }); }
function ensureChampionship(c) { c.pointsWin ??= 3; c.pointsDraw ??= 1; c.status ??= 'registration'; c.format ??= 'league'; c.edition ??= ''; c.groups ??= c.format==='groups_knockout'?2:1; c.knockoutLegs ??= 1; c.leagueLegs ??= 1; c.qualifiersPerGroup ??= 2; c.randomDraw ??= false; c.registrationMinutes ??= 1440; if(c.maxParticipants===undefined||c.maxParticipants===null){ c.maxParticipants = c.registrationLimit!==undefined&&c.registrationLimit!==null ? Number(c.registrationLimit)||0 : 0; } c.registrationLimit=Number(c.maxParticipants)||0; c.registrationEndsAt ??= null; c.registrationToken ??= registrationToken(); c.phases ??= []; c.podium ??= []; return c; }
function closeExpiredRegistration(db,c) {
  if (!c || c.status !== 'registration' || !c.registrationEndsAt) return false;
  if (Date.now() < new Date(c.registrationEndsAt).getTime()) return false;
  c.status = 'registration_closed';
  c.registrationClosedAt = now();
  for (const r of (db.joinRequests || [])) if (r.championshipId === c.id && r.status === 'pending') { r.status = 'expired'; r.respondedAt = now(); }
  db.notifications = (db.notifications || []).filter(n => !(n.championshipId === c.id && n.type === 'join_request'));
  return true;
}
function syncRegistrations(db) { let changed=false; for (const c of db.championships) { ensureChampionship(c); if (closeExpiredRegistration(db,c)) changed=true; } return changed; }
function phase(db, cid, type) { return db.phases.find(p=>p.championshipId===cid && p.type===type); }
function phaseMatches(db, cid, phaseId) { return db.matches.filter(m=>m.championshipId===cid && m.phaseId===phaseId); }
function repairKnockoutData(db,c){
  const types=['round_of_16','quarterfinal','semifinal','final'];
  const phases=db.phases.filter(p=>p.championshipId===c.id&&types.includes(p.type)).sort((a,b)=>a.order-b.order||String(a.id).localeCompare(String(b.id)));
  const keepPhaseByType=new Map();
  for(const p of phases){
    if(!keepPhaseByType.has(p.type)) keepPhaseByType.set(p.type,p);
  }
  if(phases.length!==keepPhaseByType.size){
    const keepIds=new Set([...keepPhaseByType.values()].map(p=>p.id));
    db.phases=db.phases.filter(p=>p.championshipId!==c.id||!types.includes(p.type)||keepIds.has(p.id));
    db.matches=db.matches.filter(m=>m.championshipId!==c.id||!types.includes(m.phaseType)||keepIds.has(m.phaseId));
  }
  const maxPositions={round_of_16:8,quarterfinal:4,semifinal:2,final:1};
  for(const p of keepPhaseByType.values()){
    const ms=phaseMatches(db,c.id,p.id);
    const seen=new Set(); const remove=new Set();
    const max=maxPositions[p.type]||0;
    for(const m of ms){
      const pos=Number(m.bracketPosition);
      if(!Number.isInteger(pos)||pos<1||pos>max){remove.add(m.id);continue;}
      const leg=m.tieBreak?'tb':(Number(m.leg)||1);
      const key=`${pos}|${leg}`;
      if(seen.has(key)) remove.add(m.id); else seen.add(key);
    }
    if(remove.size) db.matches=db.matches.filter(m=>!remove.has(m.id));
  }
}
function dedupeFinalPhase(db,c){
  const finals=db.phases.filter(p=>p.championshipId===c.id&&p.type==='final').sort((a,b)=>a.order-b.order);
  if(!finals.length)return null;
  const finalPhase=finals[finals.length-1];
  const ms=phaseMatches(db,c.id,finalPhase.id);
  if(ms.length<=1)return finalPhase;
  const official=ms.find(m=>m.status==='confirmed'||m.status==='waiting_confirmation'||m.status==='disputed')||ms[0];
  db.matches=db.matches.filter(m=>m.phaseId!==finalPhase.id||m.id===official.id);
  return finalPhase;
}
function playerForUser(db, uid) { const u=db.users.find(x=>x.id===uid); return db.players.find(p=>p.id===u?.playerId) || db.players.find(p=>p.username===u?.username); }
function userTeams(db, uid, cid=null) { const u=db.users.find(x=>x.id===uid); const pid=u?.playerId; return db.teams.filter(t=>(pid&&t.playerId===pid) || t.userId===uid).filter(t=>!cid || t.championshipId===cid); }
function activeTeam(db, uid, cid=null) { return userTeams(db,uid,cid)[0] || null; }

function standings(db,cid,groupId=null,phaseId=null) {
  const c=championship(db,cid); const teams=db.teams.filter(t=>t.championshipId===cid && (!groupId || t.groupId===groupId));
  const rows=new Map(teams.map(t=>[t.id,{teamId:t.id,name:t.name,groupId:t.groupId,played:0,wins:0,draws:0,losses:0,gf:0,ga:0,points:0}]));
  const ms=db.matches.filter(m=>m.championshipId===cid && m.status==='confirmed' && (!phaseId || m.phaseId===phaseId) && (!groupId || m.groupId===groupId));
  for(const m of ms){ const h=rows.get(m.homeTeamId),a=rows.get(m.awayTeamId); if(!h||!a||m.homeScore==null||m.awayScore==null)continue; h.played++;a.played++;h.gf+=m.homeScore;h.ga+=m.awayScore;a.gf+=m.awayScore;a.ga+=m.homeScore; if(m.homeScore>m.awayScore){h.wins++;h.points+=c?.pointsWin??3;a.losses++;} else if(m.homeScore<m.awayScore){a.wins++;a.points+=c?.pointsWin??3;h.losses++;} else {h.draws++;a.draws++;h.points+=c?.pointsDraw??1;a.points+=c?.pointsDraw??1;} }
  return [...rows.values()].map(r=>({...r,gd:r.gf-r.ga})).sort((a,b)=>b.points-a.points||b.gd-a.gd||b.gf-a.gf||a.name.localeCompare(b.name)).map((r,i)=>({...r,position:i+1}));
}
function roundRobin(ids){ const arr=[...ids]; if(arr.length%2)arr.push(null); const n=arr.length; const rounds=[]; let a=[...arr]; for(let r=0;r<n-1;r++){const games=[];for(let i=0;i<n/2;i++){const x=a[i],y=a[n-1-i];if(x&&y)games.push([x,y]);}rounds.push(games);a=[a[0],a[n-1],...a.slice(1,n-1)];}return rounds; }
function addPhase(db,c,type,order,extra={}) { const p={id:id('phase'),championshipId:c.id,type,order,status:'pending',createdAt:now(),...extra}; db.phases.push(p); return p; }
function addMatch(db,c,p,home,away,round=1,extra={}) { const m={id:id('mat'),championshipId:c.id,phaseId:p.id,phaseType:p.type,groupId:extra.groupId??null,round,bracketPosition:extra.bracketPosition??null,homeTeamId:home,awayTeamId:away,homeScore:null,awayScore:null,status:'pending',submissions:{},resultType:null,adminNote:null,createdAt:now(),...extra}; db.matches.push(m); return m; }
function generateLeagueMatches(db,c,p,groups){ let round=1,created=[]; const legs=Number(c.leagueLegs)||1; for(const gid of groups){const ids=db.teams.filter(t=>t.championshipId===c.id&&(!gid||t.groupId===gid)).map(t=>t.id); const first=roundRobin(ids); const schedules=legs===2?[...first,...first.map(g=>g.map(([a,b])=>[b,a]))]:first; for(const games of schedules){for(const [h,a] of games)created.push(addMatch(db,c,p,h,a,round,{groupId:gid}));round++;}} return created; }
function knockoutOrder(n){ if(n<=2)return ['final']; if(n<=4)return ['semifinal','final']; if(n<=8)return ['quarterfinal','semifinal','final']; return ['round_of_16','quarterfinal','semifinal','final']; }
function nextPowerBracket(n){ if(n<=2)return 2;if(n<=4)return 4;if(n<=8)return 8;return 16; }
function createKnockoutFromTeams(db,c,seeded,fromType='auto') {
  const clean=[...new Set(seeded.filter(Boolean))];
  if(clean.length<2)return null;
  const size=nextPowerBracket(clean.length);
  const firstType=size===16?'round_of_16':size===8?'quarterfinal':size===4?'semifinal':'final';
  const p=phase(db,c.id,firstType)||addPhase(db,c,firstType,db.phases.filter(x=>x.championshipId===c.id).length+1);
  if(db.matches.some(m=>m.phaseId===p.id))return p;
  if(firstType==='final'){
    addMatch(db,c,p,clean[0],clean[1],1,{bracketPosition:1,source:fromType,leg:1,seriesId:id('series')});
    p.status='active'; return p;
  }
  // Monte a primeira fase de forma que o número de classificados para a próxima fase
  // seja exatamente metade do tamanho da chave. Ex.: 10 times -> 8 classificados,
  // 6 times -> 4, 16 -> 8. Os BYEs são distribuídos entre os primeiros confrontos.
  const target=size/2;
  const byes=Math.max(0,size-clean.length);
  const played=clean.length===size?size/2:Math.max(0,clean.length-target);
  const actualByes=Math.max(0,clean.length-(played*2));
  const byeTeams=clean.slice(0,actualByes);
  const matchTeams=clean.slice(actualByes);
  let pos=1;
  for(const t of byeTeams){
    db.matches.push({id:id('mat'),championshipId:c.id,phaseId:p.id,phaseType:p.type,round:1,bracketPosition:pos++,homeTeamId:t,awayTeamId:null,homeScore:0,awayScore:null,status:'bye',winnerTeamId:t,submissions:{},resultType:'bye',createdAt:now(),source:fromType});
  }
  for(let i=0;i<matchTeams.length;i+=2){
    const h=matchTeams[i],a=matchTeams[i+1];
    if(!h||!a)continue;
    const series=id('series');
    addMatch(db,c,p,h,a,1,{bracketPosition:pos++,source:fromType,leg:1,seriesId:series});
    if((Number(c.knockoutLegs)||1)===2 && firstType!=='final')addMatch(db,c,p,a,h,2,{bracketPosition:pos-1,source:fromType,leg:2,seriesId:series});
  }
  p.status='active'; return p;
}
function phaseComplete(db,p){ const ms=phaseMatches(db,p.championshipId,p.id); return ms.length>0 && ms.every(m=>['confirmed','bye'].includes(m.status)); }
function seriesWinner(db,ms){
  if(!ms.length)return null;
  const first=ms.find(m=>m.leg===1)||ms[0];
  const legs=ms.filter(m=>m.seriesId===first.seriesId && m.status==='confirmed');
  if((Number(legs[0]?.championshipKnockoutLegs)||0)===2 || legs.length>=2){
    let a=0,b=0; for(const m of legs){a+=(m.homeTeamId===first.homeTeamId?m.homeScore:m.awayScore)||0; b+=(m.homeTeamId===first.homeTeamId?m.awayScore:m.homeScore)||0;}
    if(a>b)return first.homeTeamId; if(b>a)return first.awayTeamId; return null;
  }
  if(first.homeScore>first.awayScore)return first.homeTeamId; if(first.awayScore>first.homeScore)return first.awayTeamId; return null;
}
function winnersOfPhase(db,p){
  const ms=phaseMatches(db,p.championshipId,p.id); const groups=new Map();
  for(const m of ms){ if(m.status==='bye'){groups.set(m.seriesId||m.id,m.winnerTeamId);continue;} const key=m.seriesId||m.id; if(!groups.has(key))groups.set(key,m.id); }
  const out=[]; for(const v of groups.values()){ const arr=typeof v==='string'?[db.matches.find(m=>m.id===v)]:[]; const list=arr[0]?[arr[0]]:ms.filter(m=>(m.seriesId||m.id)===v); if(!list.length)continue; const first=list[0]; if(first.status==='bye'){out.push(first.winnerTeamId);continue;} const legs=ms.filter(m=>(m.seriesId||m.id)===(first.seriesId||first.id)); if(legs.some(m=>m.status!=='confirmed'))continue; const legsCount=legs.length; if(legsCount>=2){let home=0,away=0;const homeId=first.homeTeamId,awayId=first.awayTeamId;for(const m of legs){if(m.homeTeamId===homeId){home+=m.homeScore||0;away+=m.awayScore||0}else{home+=m.awayScore||0;away+=m.homeScore||0}} if(home>away)out.push(homeId);else if(away>home)out.push(awayId);else if(first.winnerTeamId)out.push(first.winnerTeamId);} else {if(first.winnerTeamId)out.push(first.winnerTeamId);else if(first.homeScore>first.awayScore)out.push(first.homeTeamId);else if(first.awayScore>first.homeScore)out.push(first.awayTeamId);}} return out.filter(Boolean);
}
function createNextKnockoutPhase(db,c,current,winners){
  const next={round_of_16:'quarterfinal',quarterfinal:'semifinal',semifinal:'final'}[current.type]; if(!next)return null;
  const unique=[]; for(const tid of winners){if(tid&&!unique.includes(tid))unique.push(tid);}
  const np=phase(db,c.id,next)||addPhase(db,c,next,current.order+1);
  if(db.matches.some(m=>m.phaseId===np.id))return np;
  if(unique.length===2 && next==='final'){
    addMatch(db,c,np,unique[0],unique[1],1,{bracketPosition:1,source:'advance',seriesId:id('series'),leg:1});
    np.status='active'; return np;
  }
  if(next==='final'){
    if(unique.length===1){
      np.status='finished'; c.championTeamId=unique[0]; c.championId=team(db,unique[0])?.playerId||null; c.status='finished'; c.finishedAt=now(); c.podium=[{position:1,teamId:unique[0],name:teamName(db,unique[0])}]; registerTitle(db,c,unique[0]); c.celebrationId=c.celebrationId||id('celebration'); return np;
    }
    return np;
  }
  const size=next==='quarterfinal'?8:next==='semifinal'?4:2;
  let pos=1;
  for(let i=0;i<unique.length;i+=2){
    const h=unique[i],a=unique[i+1];
    if(h&&a){const series=id('series');addMatch(db,c,np,h,a,1,{bracketPosition:pos++,source:'advance',seriesId:series,leg:1});if((Number(c.knockoutLegs)||1)===2)addMatch(db,c,np,a,h,2,{bracketPosition:pos-1,source:'advance',seriesId:series,leg:2});}
    else if(h){db.matches.push({id:id('mat'),championshipId:c.id,phaseId:np.id,phaseType:np.type,round:1,bracketPosition:pos++,homeTeamId:h,awayTeamId:null,homeScore:0,awayScore:null,status:'bye',winnerTeamId:h,submissions:{},resultType:'bye',createdAt:now(),source:'advance'});}
  }
  np.status='active'; return np;
}
function advanceKnockout(db,c){
  const current=db.phases.filter(p=>p.championshipId===c.id&&['round_of_16','quarterfinal','semifinal','final'].includes(p.type)).sort((a,b)=>a.order-b.order).find(p=>p.status==='active');
  if(!current)return false;
  const ms=phaseMatches(db,c.id,current.id); if(!ms.length)return false;
  const seriesIds=[...new Set(ms.map(m=>m.seriesId||m.id))]; const winners=[]; let changed=false;
  for(const sid of seriesIds){
    const series=ms.filter(m=>(m.seriesId||m.id)===sid);
    if(series.some(m=>!['confirmed','bye'].includes(m.status)))return changed;
    const first=series[0];
    if(series.some(m=>m.status==='bye')){winners.push(series.find(m=>m.status==='bye').winnerTeamId);continue;}
    const isTwoLeg=series.some(m=>Number(m.leg)===2);
    if(isTwoLeg){
      const homeId=first.homeTeamId,awayId=first.awayTeamId; let home=0,away=0;
      for(const m of series.filter(x=>!x.tieBreak)){if(m.homeTeamId===homeId){home+=Number(m.homeScore)||0;away+=Number(m.awayScore)||0}else{home+=Number(m.awayScore)||0;away+=Number(m.homeScore)||0}}
      if(home>away)winners.push(homeId); else if(away>home)winners.push(awayId); else {
        let tb=series.find(m=>m.tieBreak);
        if(!tb){tb=addMatch(db,c,current,homeId,awayId,Math.max(...series.map(m=>m.round||1))+1,{bracketPosition:first.bracketPosition,seriesId:first.seriesId||sid,tieBreak:true}); changed=true; continue;}
        if(tb.status!=='confirmed')return changed;
        if(tb.homeScore>tb.awayScore)winners.push(tb.homeTeamId); else if(tb.awayScore>tb.homeScore)winners.push(tb.awayTeamId); else return changed;
      }
    } else {
      if(first.homeScore>first.awayScore)winners.push(first.homeTeamId); else if(first.awayScore>first.homeScore)winners.push(first.awayTeamId); else {
        let tb=series.find(m=>m.tieBreak);
        if(!tb){tb=addMatch(db,c,current,first.homeTeamId,first.awayTeamId,(first.round||1)+1,{bracketPosition:first.bracketPosition,seriesId:first.seriesId||sid,tieBreak:true}); first.tieBreakCreated=true; changed=true; continue;}
        if(tb.status!=='confirmed')return changed;
        if(tb.homeScore>tb.awayScore)winners.push(tb.homeTeamId); else if(tb.awayScore>tb.homeScore)winners.push(tb.awayTeamId); else return changed;
      }
    }
  }
  const expected=Math.ceil(ms.filter(m=>m.status!=='bye'&&!m.tieBreak).filter(m=>Number(m.leg)!==2).length);
  if(winners.length<expected)return changed;
  current.status='finished'; changed=true;
  if(current.type==='final'){const champ=winners[0]||null;c.championTeamId=champ;c.championId=team(db,champ)?.playerId||null;c.status='finished';c.finishedAt=now();c.podium=champ?[{position:1,teamId:champ,name:teamName(db,champ)}]:[];current.status='finished';for(const p of db.phases.filter(x=>x.championshipId===c.id))p.status='finished';registerTitle(db,c,champ);c.celebrationId=champ?c.celebrationId||id('celebration'):null;return changed;}
  createNextKnockoutPhase(db,c,current,winners); return changed;
}
function progressChampionship(db,c){
  ensureChampionship(c);
  repairKnockoutData(db,c);
  let changed=true,guard=0;
  // A Final é sempre uma única partida. Se uma versão anterior deixou cópias, saneia antes de processar.
  const finalPhase=dedupeFinalPhase(db,c);
  // Garantia de encerramento: a Final é a última fase. Nunca cria outra partida depois dela.
  if(c.status!=='finished' && finalPhase){
    const finals=phaseMatches(db,c.id,finalPhase.id);
    const resolved=finals.filter(m=>['confirmed','bye'].includes(m.status));
    if(finalPhase.status==='finished' || (finals.length>0 && resolved.length===finals.length)){
      const winner=resolved.find(m=>m.winnerTeamId)?.winnerTeamId || (()=>{
        const m=resolved[resolved.length-1];
        if(!m)return null;
        if(m.homeScore>m.awayScore)return m.homeTeamId;
        if(m.awayScore>m.homeScore)return m.awayTeamId;
        return null;
      })();
      if(winner){
        finalPhase.status='finished';
        c.championTeamId=winner;
        c.championId=team(db,winner)?.playerId||null;
        c.status='finished';
        c.finishedAt=c.finishedAt||now();
        c.podium=c.podium?.length?c.podium:[{position:1,teamId:winner,name:teamName(db,winner)}];
        registerTitle(db,c,winner);
        c.celebrationId=c.celebrationId||id('celebration');
        for(const p of db.phases.filter(x=>x.championshipId===c.id))p.status='finished';
        return true;
      }
    }
  }
  while(changed&&guard++<10){changed=false;
    const stage=db.phases.filter(p=>p.championshipId===c.id&&['league','groups'].includes(p.type)&&p.status!=='finished').find(p=>phaseComplete(db,p));
    if(stage){stage.status='finished';changed=true;
      if(c.format==='league'){if(c.format==='league'){const s=standings(db,c.id);c.championTeamId=s[0]?.teamId||null;c.championId=team(db,c.championTeamId)?.playerId||null;c.podium=s.slice(0,3).map(r=>({position:r.position,teamId:r.teamId,name:r.name,points:r.points,gf:r.gf,ga:r.ga,gd:r.gd}));c.status='finished';c.finishedAt=now();registerTitle(db,c,c.championTeamId);c.celebrationId=c.championTeamId?c.celebrationId||id('celebration'):null;}}
      else {let qualified=[];if(c.format==='groups_knockout'){const names=['A','B','C','D'].slice(0,Math.max(2,Number(c.groups)||2)); for(const gn of names){qualified.push(...standings(db,c.id,gn,stage.id).slice(0,Number(c.qualifiersPerGroup)||2).map(x=>x.teamId));}}else { const total=standings(db,c.id,null,stage.id).length; const slots=total>=16?16:total>=8?8:total>=4?4:2; qualified=standings(db,c.id,null,stage.id).slice(0,slots).map(x=>x.teamId); } if(c.randomDraw)qualified.sort(()=>Math.random()-0.5);createKnockoutFromTeams(db,c,qualified,'stage');c.status='active';}
    }
    if(c.status!=='finished'&&advanceKnockout(db,c))changed=true;
  } return changed;
}
function registerTitle(db,c,teamId){ if(!teamId||c.titleRegistered)return; const t=team(db,teamId); const pid=t?.playerId; if(!pid)return; db.titles.push({id:id('title'),playerId:pid,championshipId:c.id,championshipName:c.name,edition:c.edition||null,title:'Campeão',wonAt:now()}); c.titleRegistered=true; }
function finishLeagueIfComplete(db,c){ return progressChampionship(db,c); }
function migrateLegacy(db){ db.players ||= []; db.participations ||= []; db.phases ||= []; db.titles ||= []; db.joinRequests ||= []; db.celebrationViews ||= []; syncRegistrations(db); for(const u of db.users){ if(u.role==='player'&&!u.playerId){ let p=db.players.find(x=>x.username===u.username)||{id:id('ply'),name:u.name||u.username,username:u.username,displayName:u.displayName||u.name,createdAt:u.createdAt||now()}; if(!db.players.some(x=>x.id===p.id))db.players.push(p); u.playerId=p.id; } }
  for(const t of db.teams){ if(!t.playerId&&t.userId){t.playerId=db.users.find(u=>u.id===t.userId)?.playerId||null;} if(!t.playerId){const u=db.users.find(u=>u.teamId===t.id);t.playerId=u?.playerId||null;} if(t.playerId&&!db.participations.some(x=>x.championshipId===t.championshipId&&x.playerId===t.playerId))db.participations.push({id:id('part'),championshipId:t.championshipId,playerId:t.playerId,teamId:t.id,createdAt:t.createdAt||now()}); }
  for(const c of db.championships)ensureChampionship(c);
  return db;
}

app.get('/api/health',(_,res)=>res.json({ok:true,app:'Champions Amigos',version:'7.0.0-password-notifications'}));
app.post('/api/auth/login',async(req,res)=>{const db=migrateLegacy(readDb()),{username,password}=req.body;const u=db.users.find(x=>x.username?.toLowerCase()===String(username||'').toLowerCase());if(!u||!(await bcrypt.compare(String(password||''),u.passwordHash)))return res.status(401).json({error:'Usuário ou senha inválidos.'});writeDb(db);res.json({token:signUser(u),user:cleanUser(u)});});
app.get('/api/me',auth,(req,res)=>{const db=migrateLegacy(readDb()),u=db.users.find(x=>x.id===req.user.id);if(!u)return res.status(401).json({error:'Conta não encontrada.'});writeDb(db);res.json(cleanUser(u));});
app.get('/api/admin/public',auth,(req,res)=>res.json(adminPublic(readDb())));
app.get('/api/dashboard',auth,adminOnly,(req,res)=>{
  const db=migrateLegacy(readDb());
  const matches=db.matches.filter(m=>m.status!=='bye');
  const confirmed=matches.filter(m=>m.status==='confirmed').length;
  const disputed=matches.filter(m=>m.status==='disputed').length;
  const pending=matches.filter(m=>!['confirmed','disputed'].includes(m.status)).length;
  const unread=(db.notifications||[]).filter(n=>n.createdFor==='admin'&&!n.read).length;
  res.json({
    championships:db.championships.length,
    teams:db.players.length,
    totalMatches:matches.length,
    confirmed,
    pending,
    disputed,
    finished:db.championships.filter(c=>c.status==='finished').length,
    notifications:unread
  });
});
app.post('/api/account/setup',auth,adminOnly,async(req,res)=>{const db=readDb(),u=db.users.find(x=>x.id===req.user.id);const {username,password,displayName}=req.body;if(!u)return res.status(404).json({error:'Conta não encontrada.'});if(!validUsername(username)||!validPassword(password))return res.status(400).json({error:'Usuário ou senha inválidos.'});if(db.users.some(x=>x.id!==u.id&&x.username.toLowerCase()===username.toLowerCase()))return res.status(409).json({error:'Esse usuário já existe.'});u.username=username.trim();u.passwordHash=await bcrypt.hash(password,10);u.displayName=String(displayName||u.name||'Administrador').trim();u.mustChangeCredentials=false;let key=null;if(!u.recoveryKeyHash){key=recoveryKey();u.recoveryKeyHash=await bcrypt.hash(key,10);}writeDb(db);res.json({token:signUser(u),user:cleanUser(u),recoveryKey:key});});
app.post('/api/account/credentials',auth,adminOnly,async(req,res)=>{const db=readDb(),u=db.users.find(x=>x.id===req.user.id);if(req.body.username&&(!validUsername(req.body.username)||db.users.some(x=>x.id!==u.id&&x.username.toLowerCase()===req.body.username.toLowerCase())))return res.status(400).json({error:'Usuário inválido ou já existente.'});if(req.body.password&&!validPassword(req.body.password))return res.status(400).json({error:'Senha inválida.'});if(req.body.username)u.username=req.body.username.trim();if(req.body.password)u.passwordHash=await bcrypt.hash(req.body.password,10);if(req.body.displayName!==undefined)u.displayName=String(req.body.displayName).trim();writeDb(db);res.json({token:signUser(u),user:cleanUser(u)});});
app.post('/api/account/recovery-key',auth,adminOnly,async(req,res)=>{const db=readDb(),u=db.users.find(x=>x.id===req.user.id),key=recoveryKey();u.recoveryKeyHash=await bcrypt.hash(key,10);writeDb(db);res.json({recoveryKey:key});});
app.put('/api/account/profile',auth,async(req,res)=>{const db=readDb(),u=db.users.find(x=>x.id===req.user.id);if(!u)return res.status(404).json({error:'Conta não encontrada.'});if(req.body.username&&(!validUsername(req.body.username)||db.users.some(x=>x.id!==u.id&&x.username.toLowerCase()===req.body.username.toLowerCase())))return res.status(400).json({error:'Usuário inválido ou já existente.'});if(req.body.password&&!validPassword(req.body.password))return res.status(400).json({error:'Senha inválida.'});if(req.body.username)u.username=req.body.username.trim();if(req.body.password)u.passwordHash=await bcrypt.hash(req.body.password,10);if(req.body.displayName!==undefined)u.displayName=String(req.body.displayName).trim();writeDb(db);res.json({token:signUser(u),user:cleanUser(u)});});
app.get('/api/notifications',auth,adminOnly,(req,res)=>{
  const db=readDb();
  res.json((db.notifications||[]).filter(n=>n.createdFor==='admin').slice(0,100));
});
app.get('/api/my/notifications',auth,(req,res)=>{
  const db=migrateLegacy(readDb());
  const u=db.users.find(x=>x.id===req.user.id);
  const pid=u?.playerId;
  const allowed=new Set(db.participations.filter(x=>x.playerId===pid).map(x=>x.championshipId));
  res.json((db.notifications||[]).filter(n=>(!n.userId||n.userId===u.id)&&(!n.createdFor||n.createdFor==='player' || (n.championshipId&&allowed.has(n.championshipId)))).slice(0,100));
});
app.get('/api/celebrations/pending',auth,(req,res)=>{
  const db=migrateLegacy(readDb());
  const u=db.users.find(x=>x.id===req.user.id);
  if(!u?.playerId)return res.json([]);
  const participated=new Set(db.participations.filter(x=>x.playerId===u.playerId).map(x=>x.championshipId));
  const viewed=new Set((db.celebrationViews||[]).filter(v=>v.userId===u.id).map(v=>v.championshipId));
  const items=db.championships.filter(c=>c.status==='finished'&&c.celebrationId&&participated.has(c.id)&&!viewed.has(c.id))
    .sort((a,b)=>String(b.finishedAt||b.createdAt||'').localeCompare(String(a.finishedAt||a.createdAt||'')))
    .map(c=>({id:c.celebrationId,championshipId:c.id,name:c.name,podium:c.podium||[]}));
  res.json(items.slice(0,5));
});
app.post('/api/celebrations/:id/viewed',auth,(req,res)=>{
  const db=migrateLegacy(readDb());
  const c=db.championships.find(x=>x.celebrationId===req.params.id&&x.status==='finished');
  if(!c)return res.status(404).json({error:'Celebração não encontrada.'});
  const u=db.users.find(x=>x.id===req.user.id);
  if(!u?.playerId||!db.participations.some(x=>x.championshipId===c.id&&x.playerId===u.playerId))return res.status(403).json({error:'Você não participou deste campeonato.'});
  db.celebrationViews ||= [];
  if(!db.celebrationViews.some(v=>v.userId===u.id&&v.championshipId===c.id))db.celebrationViews.push({id:id('cv'),userId:u.id,championshipId:c.id,viewedAt:now()});
  writeDb(db);
  res.json({ok:true});
});
app.post('/api/auth/forgot-player',async(req,res)=>{const db=readDb(),u=db.users.find(x=>x.role==='player'&&x.username?.toLowerCase()===String(req.body.username||'').toLowerCase());if(u){ const exists=(db.notifications||[]).some(n=>n.type==='password_reset'&&n.createdFor==='admin'&&n.userId===u.id&&n.status!=='resolved'); if(!exists)notification(db,{type:'password_reset',title:'Recuperação de senha solicitada',message:`${u.name||u.username} solicitou redefinição de senha.`,createdFor:'admin',userId:u.id,status:'pending'}); }writeDb(db);res.json({ok:true,message:'Solicitação registrada.'});});
app.post('/api/auth/admin-bootstrap',async(req,res)=>{try{if(!process.env.ADMIN_BOOTSTRAP_KEY||String(req.body.key||'')!==process.env.ADMIN_BOOTSTRAP_KEY)return res.status(401).json({error:'Não autorizado.'});const db=readDb(),u=db.users.find(x=>x.role==='admin');if(!u){u={id:id('usr'),name:'Administrador',role:'admin',username:'admin',passwordHash:'',createdAt:now(),mustChangeCredentials:false};db.users.push(u);}const password=String(req.body.password||'');if(!validPassword(password))return res.status(400).json({error:'Senha inválida.'});u.passwordHash=await bcrypt.hash(password,10);u.mustChangeCredentials=false;writeDb(db);res.json({ok:true,user:cleanUser(u)});}catch(e){res.status(500).json({error:'Erro interno.'});}});
app.post('/api/auth/admin-recover',async(req,res)=>{const db=readDb(),u=db.users.find(x=>x.role==='admin'&&x.username?.toLowerCase()===String(req.body.username||'').toLowerCase());if(!u||!u.recoveryKeyHash||!(await bcrypt.compare(String(req.body.recoveryKey||''),u.recoveryKeyHash)))return res.status(401).json({error:'Usuário ou chave de recuperação inválidos.'});if(!validPassword(req.body.password))return res.status(400).json({error:'Senha inválida.'});u.passwordHash=await bcrypt.hash(req.body.password,10);const key=recoveryKey();u.recoveryKeyHash=await bcrypt.hash(key,10);writeDb(db);res.json({token:signUser(u),user:cleanUser(u),recoveryKey:key});});
app.post('/api/admin/players/:uid/reset-password',auth,adminOnly,async(req,res)=>{const db=readDb(),u=db.users.find(x=>x.id===req.params.uid&&x.role==='player');if(!u)return res.status(404).json({error:'Participante não encontrado.'});if(!validPassword(req.body.password))return res.status(400).json({error:'Senha inválida.'});u.passwordHash=await bcrypt.hash(req.body.password,10);for(const n of (db.notifications||[])){if(n.type==='password_reset'&&n.createdFor==='admin'&&n.userId===u.id){n.status='resolved';n.read=true;n.resolvedAt=now();}}writeDb(db);res.json({ok:true});});
app.post('/api/notifications/:id/reset-password',auth,adminOnly,async(req,res)=>{const db=readDb(),n=(db.notifications||[]).find(x=>x.id===req.params.id&&x.type==='password_reset'&&x.createdFor==='admin');if(!n)return res.status(404).json({error:'Solicitação de recuperação não encontrada.'});const u=db.users.find(x=>x.id===n.userId&&x.role==='player');if(!u)return res.status(404).json({error:'Participante não encontrado.'});if(!validPassword(req.body.password))return res.status(400).json({error:'Senha inválida. Use 8+ caracteres, maiúscula, minúscula e número.'});u.passwordHash=await bcrypt.hash(String(req.body.password),10);n.status='resolved';n.read=true;n.resolvedAt=now();writeDb(db);res.json({ok:true,message:'Senha redefinida com sucesso.',user:{id:u.id,name:u.name,username:u.username}});});
app.patch('/api/notifications/:id/read',auth,adminOnly,(req,res)=>{const db=readDb(),n=(db.notifications||[]).find(x=>x.id===req.params.id&&x.createdFor==='admin');if(!n)return res.status(404).json({error:'Notificação não encontrada.'});n.read=true;writeDb(db);res.json({ok:true});});
app.delete('/api/notifications/:id',auth,adminOnly,(req,res)=>{const db=readDb(),before=(db.notifications||[]).length;db.notifications=(db.notifications||[]).filter(x=>!(x.id===req.params.id&&x.createdFor==='admin'));if(db.notifications.length===before)return res.status(404).json({error:'Notificação não encontrada.'});writeDb(db);res.json({ok:true});});
app.delete('/api/account',auth,(req,res)=>{const db=readDb(),i=db.users.findIndex(x=>x.id===req.user.id);if(i<0)return res.status(404).json({error:'Conta não encontrada.'});const u=db.users[i];if(u.role==='admin'&&db.users.filter(x=>x.role==='admin').length===1&&db.championships.some(c=>c.status!=='finished'))return res.status(400).json({error:'Finalize os campeonatos antes de excluir o único ADM.'});db.users.splice(i,1);if(u.playerId)db.players=db.players.filter(p=>p.id!==u.playerId);writeDb(db);res.json({ok:true});});

function registrationStats(db,c){
  const confirmed=db.teams.filter(t=>t.championshipId===c.id).length;
  const pending=new Set((db.joinRequests||[]).filter(r=>r.championshipId===c.id&&r.status==='pending').map(r=>r.playerId)).size;
  const max=Number(c.maxParticipants)||0;
  const used=confirmed+pending;
  return {confirmed,pending,used,max,available:max>0?Math.max(0,max-used):null,full:max>0&&used>=max};
}
function hasRegistrationCapacity(db,c){return !registrationStats(db,c).full;}

app.get('/api/public/registration/:token', (req,res)=>{
  const db=migrateLegacy(readDb());
  const c=db.championships.find(x=>x.registrationToken===req.params.token);
  if(!c)return res.status(404).json({error:'Link de inscrição inválido ou inexistente.'});
  writeDb(db);
  const stats=registrationStats(db,c); res.json({id:c.id,name:c.name,status:c.status,registrationEndsAt:c.registrationEndsAt,registrationToken:c.registrationToken,maxParticipants:stats.max,confirmedParticipants:stats.confirmed,pendingParticipants:stats.pending,availableSlots:stats.available,full:stats.full});
});
app.get('/api/public/championships/:cid', (req,res)=>{
  const db=migrateLegacy(readDb()),c=championship(db,req.params.cid);
  if(!c)return res.status(404).json({error:'Campeonato não encontrado.'});
  writeDb(db);
  const stats=registrationStats(db,c); res.json({id:c.id,name:c.name,status:c.status,registrationEndsAt:c.registrationEndsAt,registrationToken:c.registrationToken,maxParticipants:stats.max,confirmedParticipants:stats.confirmed,pendingParticipants:stats.pending,availableSlots:stats.available,full:stats.full});
});
async function publicRegister(db,c,req,res){
  if(!c)return res.status(404).json({error:'Campeonato não encontrado.'});
  if(closeExpiredRegistration(db,c)){writeDb(db);return res.status(400).json({error:'As inscrições deste campeonato já foram encerradas.'});}
  if(c.status!=='registration')return res.status(400).json({error:'As inscrições deste campeonato já foram encerradas.'});
  const mode=req.body.mode||'signup';
  const stats=registrationStats(db,c);
  const username=String(req.body.username||'').trim();
  if(stats.full && mode==='signup')return res.status(400).json({error:'As vagas deste campeonato estão esgotadas.'});
  const password=String(req.body.password||'');
  if(mode==='login'){
    const u=db.users.find(x=>x.username?.toLowerCase()===username.toLowerCase()&&x.role==='player');
    if(!u||!await bcrypt.compare(password,u.passwordHash||''))return res.status(401).json({error:'Usuário ou senha inválidos.'});
    const p=db.players.find(x=>x.id===u.playerId);
    if(!p)return res.status(400).json({error:'Cadastro de jogador inválido.'});
    if(db.participations.some(x=>x.championshipId===c.id&&x.playerId===p.id))return res.status(409).json({error:'Você já participa deste campeonato.'});
    const alreadyPending=db.joinRequests.some(x=>x.championshipId===c.id&&x.playerId===p.id&&x.status==='pending');
    if(stats.full&&!alreadyPending)return res.status(400).json({error:'As vagas deste campeonato estão esgotadas.'});
    if(!alreadyPending)db.joinRequests.push({id:id('join'),championshipId:c.id,playerId:p.id,userId:u.id,status:'pending',createdAt:now()});
    notification(db,{type:'join_request',title:'Convite para participar',message:`Você recebeu um convite para participar de ${c.name}.`,championshipId:c.id,createdFor:'player',userId:u.id});
    writeDb(db);
    return res.json({requested:true,token:signUser(u),user:cleanUser(u),championship:{id:c.id,name:c.name}});
  }
  const name=String(req.body.name||'').trim();
  if(!name||!validUsername(username)||!validPassword(password))return res.status(400).json({error:'Informe nome, usuário válido e senha forte (8+ caracteres, maiúscula, minúscula e número).'});
  if(db.users.some(x=>x.username?.toLowerCase()===username.toLowerCase()))return res.status(409).json({error:'Esse usuário já existe. Use a opção de entrar.'});
  const p={id:id('ply'),name,username,displayName:name,createdAt:now()};
  const u={id:id('usr'),name,role:'player',playerId:p.id,username,passwordHash:await bcrypt.hash(password,10),createdAt:now(),mustChangeCredentials:false};
  db.players.push(p);db.users.push(u);
  const t={id:id('team'),name,playerId:p.id,userId:u.id,championshipId:c.id,groupId:null,createdAt:now()};
  db.teams.push(t);db.participations.push({id:id('part'),championshipId:c.id,playerId:p.id,teamId:t.id,createdAt:now()});u.teamId=t.id;
  writeDb(db);
  res.json({registered:true,token:signUser(u),user:cleanUser(u),championship:{id:c.id,name:c.name}});
}
app.post('/api/public/registration/:token/register', async (req,res)=>{
  const db=migrateLegacy(readDb());
  const c=db.championships.find(x=>x.registrationToken===req.params.token);
  return publicRegister(db,c,req,res);
});
app.post('/api/public/championships/:cid/register', async (req,res)=>{
  const db=migrateLegacy(readDb()),c=championship(db,req.params.cid);
  return publicRegister(db,c,req,res);
});
app.get('/api/join-requests',auth,(req,res)=>{const db=readDb(),pid=db.users.find(x=>x.id===req.user.id)?.playerId;res.json((db.joinRequests||[]).filter(x=>x.playerId===pid&&x.status==='pending').map(x=>({id:x.id,championshipId:x.championshipId,championshipName:championship(db,x.championshipId)?.name||'Campeonato'})));});
app.post('/api/join-requests/:id/accept',auth,(req,res)=>{const db=readDb(),r=(db.joinRequests||[]).find(x=>x.id===req.params.id&&x.status==='pending');const pid=db.users.find(x=>x.id===req.user.id)?.playerId;if(!r||r.playerId!==pid)return res.status(404).json({error:'Convite não encontrado.'});const c=championship(db,r.championshipId);if(!c||c.status!=='registration'){r.status='expired';writeDb(db);return res.status(400).json({error:'As inscrições deste campeonato já foram encerradas.'});}if(registrationStats(db,c).full){r.status='expired';r.respondedAt=now();writeDb(db);return res.status(400).json({error:'As vagas deste campeonato já foram preenchidas.'});}if(!db.participations.some(x=>x.championshipId===c.id&&x.playerId===pid)){const p=db.players.find(x=>x.id===pid);const u=db.users.find(x=>x.id===req.user.id);const t={id:id('team'),name:p?.displayName||p?.name||u.name,playerId:pid,userId:u.id,championshipId:c.id,groupId:null,createdAt:now()};db.teams.push(t);db.participations.push({id:id('part'),championshipId:c.id,playerId:pid,teamId:t.id,createdAt:now()});u.teamId=t.id;}r.status='accepted';r.respondedAt=now();db.notifications=(db.notifications||[]).filter(n=>!(n.userId===req.user.id&&n.championshipId===c.id&&n.type==='join_request'));writeDb(db);res.json({ok:true});});
app.post('/api/join-requests/:id/deny',auth,(req,res)=>{const db=readDb(),r=(db.joinRequests||[]).find(x=>x.id===req.params.id&&x.status==='pending');const pid=db.users.find(x=>x.id===req.user.id)?.playerId;if(!r||r.playerId!==pid)return res.status(404).json({error:'Convite não encontrado.'});r.status='denied';r.respondedAt=now();db.notifications=(db.notifications||[]).filter(n=>!(n.userId===req.user.id&&n.championshipId===r.championshipId&&n.type==='join_request'));writeDb(db);res.json({ok:true});});
app.get('/api/championships',auth,(req,res)=>{const db=migrateLegacy(readDb()); const all=db.championships.map(c=>ensureChampionship(c)); if(req.user.role==='admin'){writeDb(db);return res.json(all);} const pid=db.users.find(u=>u.id===req.user.id)?.playerId; const allowed=new Set(db.participations.filter(x=>x.playerId===pid).map(x=>x.championshipId)); writeDb(db); res.json(all.filter(c=>allowed.has(c.id)));});
app.post('/api/championships',auth,adminOnly,(req,res)=>{const db=readDb();const {name,edition='',format='league',groups=1,pointsWin=3,pointsDraw=1,knockoutLegs=1,leagueLegs=1,qualifiersPerGroup=2,randomDraw=false,registrationMinutes=1440,maxParticipants=0}=req.body;if(!name?.trim())return res.status(400).json({error:'Nome do campeonato é obrigatório.'});if(!FORMATS[format])return res.status(400).json({error:'Formato inválido.'});if(db.championships.some(c=>c.name.toLowerCase()===name.trim().toLowerCase()))return res.status(409).json({error:'Já existe um campeonato com esse nome.'});const mins=Math.max(1,Number(registrationMinutes)||1440); const c={id:id('cmp'),name:name.trim(),edition:String(edition||''),format,groups:Number(groups)||1,pointsWin:Number(pointsWin)||3,pointsDraw:Number(pointsDraw)||1,status:'registration',registrationMinutes:mins,maxParticipants:Math.max(0,Number(maxParticipants)||0),registrationEndsAt:new Date(Date.now()+mins*60000).toISOString(),registrationToken:registrationToken(),podium:[],phases:[],knockoutLegs:Number(knockoutLegs)||1,leagueLegs:Number(leagueLegs)||1,qualifiersPerGroup:Number(qualifiersPerGroup)||2,randomDraw:Boolean(randomDraw),createdAt:now()};db.championships.push(c);writeDb(db);res.json(c);});
app.put('/api/championships/:cid',auth,adminOnly,(req,res)=>{const db=migrateLegacy(readDb()),c=championship(db,req.params.cid);if(!c)return res.status(404).json({error:'Campeonato não encontrado.'});const reactivate=Boolean(req.body.reactivateRegistration);if(c.status==='finished'&&!reactivate&&req.body.format&&req.body.format!==c.format)return res.status(400).json({error:'Formato não pode ser alterado após o encerramento.'});if(reactivate){if(db.matches.some(m=>m.championshipId===c.id))return res.status(409).json({error:'Este campeonato já possui confrontos gerados.'});const mins=Math.max(1,Number(req.body.registrationMinutes)||0);if(!mins)return res.status(400).json({error:'Informe por quantos minutos as inscrições ficarão reativadas.'});c.registrationMinutes=mins;c.registrationEndsAt=new Date(Date.now()+mins*60000).toISOString();c.status='registration';c.registrationReactivatedAt=now();c.registrationReactivationCount=Number(c.registrationReactivationCount||0)+1;} else {const allowed=['name','edition','format','groups','pointsWin','pointsDraw','knockoutLegs','leagueLegs','qualifiersPerGroup','randomDraw','registrationMinutes','maxParticipants','registrationLimit'];for(const k of allowed)if(req.body[k]!==undefined){if(k==='registrationLimit'||k==='maxParticipants'){c.maxParticipants=Math.max(0,Number(req.body[k])||0);c.registrationLimit=c.maxParticipants;}else c[k]=['groups','pointsWin','pointsDraw','knockoutLegs','leagueLegs','qualifiersPerGroup'].includes(k)?Number(req.body[k]):(['randomDraw'].includes(k)?Boolean(req.body[k]):String(req.body[k]).trim());}if(c.status==='registration'&&req.body.registrationMinutes!==undefined){const mins=Math.max(1,Number(c.registrationMinutes)||1440);c.registrationEndsAt=new Date(Date.now()+mins*60000).toISOString();}}ensureChampionship(c);writeDb(db);res.json(c);});
app.get('/api/championships/:cid',auth,(req,res)=>{const db=readDb(),c=championship(db,req.params.cid);if(!c)return res.status(404).json({error:'Campeonato não encontrado.'});if(req.user.role!=='admin'){const pid=db.users.find(u=>u.id===req.user.id)?.playerId;if(!db.participations.some(x=>x.championshipId===c.id&&x.playerId===pid))return res.status(403).json({error:'Você não participa deste campeonato.'});}res.json({championship:c,teams:db.teams.filter(t=>t.championshipId===c.id).map(t=>publicTeam(db,t)),phases:db.phases.filter(p=>p.championshipId===c.id)});});
app.post('/api/championships/:cid/teams',auth,adminOnly,async(req,res)=>{const db=readDb(),c=championship(db,req.params.cid);if(!c)return res.status(404).json({error:'Campeonato não encontrado.'});if(c.status!=='registration')return res.status(400).json({error:'Participantes só podem ser alterados durante a inscrição.'});const playerId=String(req.body.playerId||'').trim(); let existingPlayer=playerId?db.players.find(p=>p.id===playerId):null; const name=String(req.body.name||existingPlayer?.displayName||existingPlayer?.name||'').trim(),username=String(req.body.username||existingPlayer?.username||'').trim();if(!name)return res.status(400).json({error:'Nome do time/jogador é obrigatório.'});let u=existingPlayer?db.users.find(x=>x.playerId===existingPlayer.id):username?db.users.find(x=>x.username.toLowerCase()===username.toLowerCase()):null;let p=u?.playerId?db.players.find(x=>x.id===u.playerId):null;if(!p&&username)p=db.players.find(x=>x.username?.toLowerCase()===username.toLowerCase());if(!p){p={id:id('ply'),name,username:username||`jogador_${Date.now()}`,displayName:name,createdAt:now()};db.players.push(p);}if(!u){const password=req.body.password||'Jogador123';u={id:id('usr'),name,role:'player',playerId:p.id,username:p.username,passwordHash:await bcrypt.hash(password,10),createdAt:now(),mustChangeCredentials:false};db.users.push(u);}else u.playerId=p.id; if(db.teams.some(t=>t.championshipId===c.id&&t.playerId===p.id))return res.status(409).json({error:'Esse jogador já participa deste campeonato.'});if(registrationStats(db,c).full)return res.status(400).json({error:'As vagas deste campeonato estão esgotadas.'});const t={id:id('team'),name,playerId:p.id,userId:u.id,championshipId:c.id,groupId:null,createdAt:now()};db.teams.push(t);db.participations.push({id:id('part'),championshipId:c.id,playerId:p.id,teamId:t.id,createdAt:now()});u.teamId=t.id;writeDb(db);res.json({...publicTeam(db,t),userId:u.id});});
app.get('/api/championships/:cid/teams',auth,(req,res)=>{const db=migrateLegacy(readDb());res.json(db.teams.filter(t=>t.championshipId===req.params.cid).map(t=>({...publicTeam(db,t),userId:t.userId||db.users.find(u=>u.playerId===t.playerId)?.id||null})));});
app.put('/api/championships/:cid/teams/:tid',auth,adminOnly,(req,res)=>{const db=readDb(),c=championship(db,req.params.cid),t=team(db,req.params.tid);if(!c||!t||t.championshipId!==c.id)return res.status(404).json({error:'Participante não encontrado.'});if(c.status==='finished')return res.status(400).json({error:'Campeonato já encerrado.'});const name=String(req.body.name||'').trim();if(!name)return res.status(400).json({error:'Nome do participante é obrigatório.'});t.name=name;const p=db.players.find(x=>x.id===t.playerId);if(p){p.name=name;p.displayName=name;}const u=t.userId?db.users.find(x=>x.id===t.userId):db.users.find(x=>x.playerId===t.playerId);if(u)u.name=name;writeDb(db);res.json({...publicTeam(db,t),userId:t.userId||u?.id||null});});
app.delete('/api/championships/:cid/teams/:tid',auth,adminOnly,(req,res)=>{const db=readDb(),c=championship(db,req.params.cid),t=team(db,req.params.tid);if(!c||!t||t.championshipId!==c.id)return res.status(404).json({error:'Participante não encontrado.'});if(c.status!=='registration')return res.status(400).json({error:'Remova participantes somente durante a inscrição.'});db.teams=db.teams.filter(x=>x.id!==t.id);db.participations=db.participations.filter(x=>x.teamId!==t.id);writeDb(db);res.json({ok:true});});
app.delete('/api/players/:pid',auth,adminOnly,(req,res)=>{const db=readDb();const p=db.players.find(x=>x.id===req.params.pid);if(!p)return res.status(404).json({error:'Participante não encontrado.'});const uid=db.users.find(u=>u.playerId===p.id)?.id;db.participations=db.participations.filter(x=>x.playerId!==p.id);db.players=db.players.filter(x=>x.id!==p.id);if(uid)db.users=db.users.filter(u=>u.id!==uid);for(const t of db.teams.filter(t=>t.playerId===p.id)){t.playerId=null;if(uid&&t.userId===uid)t.userId=null;}writeDb(db);res.json({ok:true});});
app.get('/api/players',auth,adminOnly,(req,res)=>{const db=migrateLegacy(readDb());res.json(db.players.map(p=>{const u=db.users.find(x=>x.playerId===p.id);return {...p,userId:u?.id||null,participations:db.participations.filter(x=>x.playerId===p.id).length};}));});
app.post('/api/championships/:cid/groups',auth,adminOnly,(req,res)=>{const db=readDb(),c=championship(db,req.params.cid);if(!c)return res.status(404).json({error:'Campeonato não encontrado.'});const teams=db.teams.filter(t=>t.championshipId===c.id);const count=Math.max(2,Number(c.groups)||2);if(![2,4].includes(count))return res.status(400).json({error:'Use 2 ou 4 grupos.'});const names=['A','B','C','D'].slice(0,count);teams.forEach((t,i)=>t.groupId=names[i%count]);writeDb(db);res.json(teams);});
function reactivateRegistrationHandler(req,res){const db=migrateLegacy(readDb()),c=championship(db,req.params.cid);if(!c)return res.status(404).json({error:'Campeonato não encontrado.'});if(c.status!=='registration_closed')return res.status(400).json({error:'As inscrições deste campeonato não estão encerradas.'});const mins=Math.max(1,Number(req.body.minutes??req.body.registrationMinutes)||0);if(!mins)return res.status(400).json({error:'Informe por quantos minutos as inscrições ficarão reativadas.'});if(db.matches.some(m=>m.championshipId===c.id))return res.status(409).json({error:'Este campeonato já possui confrontos gerados.'});c.registrationMinutes=mins;c.registrationEndsAt=new Date(Date.now()+mins*60000).toISOString();c.status='registration';c.registrationReactivatedAt=now();c.registrationReactivationCount=Number(c.registrationReactivationCount||0)+1;writeDb(db);res.json({message:'Inscrições reativadas.',championship:c});}
app.post('/api/championships/:cid/reactivate-registration',auth,adminOnly,reactivateRegistrationHandler);
app.post('/api/championships/:cid/reactivate',auth,adminOnly,reactivateRegistrationHandler);
app.post('/api/championships/:cid/generate',auth,adminOnly,(req,res)=>{const db=migrateLegacy(readDb()),c=championship(db,req.params.cid);if(!c)return res.status(404).json({error:'Campeonato não encontrado.'});if(!['registration','registration_closed'].includes(c.status))return res.status(400).json({error:'Este campeonato não pode ser iniciado neste momento.'});if(db.matches.some(m=>m.championshipId===c.id))return res.status(409).json({error:'Confrontos já foram gerados.'});for(const r of (db.joinRequests||[]))if(r.championshipId===c.id&&r.status==='pending'){r.status='expired';r.respondedAt=now();}db.notifications=(db.notifications||[]).filter(n=>!(n.championshipId===c.id&&n.type==='join_request'));const teams=db.teams.filter(t=>t.championshipId===c.id);if(teams.length<2)return res.status(400).json({error:'Cadastre pelo menos 2 participantes.'});ensureChampionship(c);c.phases=[];db.phases=db.phases.filter(p=>p.championshipId!==c.id);const format=c.format;if(format==='league'){const p=addPhase(db,c,'league',1);p.status='active';generateLeagueMatches(db,c,p,[null]);}else if(format==='league_knockout'){const p=addPhase(db,c,'league',1);p.status='active';generateLeagueMatches(db,c,p,[null]);}else if(format==='groups_knockout'){if(teams.length<4)return res.status(400).json({error:'Grupos + mata-mata precisa de pelo menos 4 participantes.'});const count=Math.max(2,Number(c.groups)||2);const names=['A','B','C','D'].slice(0,count);teams.forEach((t,i)=>t.groupId=names[i%count]);const p=addPhase(db,c,'groups',1,{groups:names});p.status='active';generateLeagueMatches(db,c,p,names);}else {createKnockoutFromTeams(db,c,teams.map(t=>t.id),'direct');}c.status='active';c.startedAt=now();writeDb(db);res.json({message:'Campeonato iniciado.',championship:c,matches:db.matches.filter(m=>m.championshipId===c.id).map(m=>publicMatch(db,m))});});
app.post('/api/championships/:cid/advance',auth,adminOnly,(req,res)=>{const db=readDb(),c=championship(db,req.params.cid);if(!c)return res.status(404).json({error:'Campeonato não encontrado.'});const ok=progressChampionship(db,c);writeDb(db);res.json({ok,championship:c,phases:db.phases.filter(p=>p.championshipId===c.id),matches:db.matches.filter(m=>m.championshipId===c.id).map(m=>publicMatch(db,m))});});
app.post('/api/championships/:cid/finish',auth,adminOnly,(req,res)=>{const db=readDb(),c=championship(db,req.params.cid);if(!c)return res.status(404).json({error:'Campeonato não encontrado.'});if(c.status==='finished')return res.status(400).json({error:'Campeonato já está encerrado.'});const championTeamId=req.body.championTeamId||null;if(championTeamId&&!db.teams.some(t=>t.id===championTeamId&&t.championshipId===c.id))return res.status(400).json({error:'Campeão inválido para este campeonato.'});c.status='finished';c.finishedAt=now();c.manualFinish=true;c.championTeamId=championTeamId;c.championId=team(db,championTeamId)?.playerId||null;c.podium=championTeamId?[{position:1,teamId:championTeamId,name:teamName(db,championTeamId)}]:[];if(championTeamId)registerTitle(db,c,championTeamId);c.celebrationId=championTeamId?id('celebration'):null;for(const p of db.phases.filter(x=>x.championshipId===c.id))p.status='finished';writeDb(db);res.json(c);});
app.delete('/api/championships/:cid',auth,adminOnly,(req,res)=>{const db=readDb(),c=championship(db,req.params.cid);if(!c)return res.status(404).json({error:'Campeonato não encontrado.'});if(c.status!=='finished')return res.status(400).json({error:'Finalize o campeonato antes de excluí-lo.'});const tids=db.teams.filter(t=>t.championshipId===c.id).map(t=>t.id);const pids=db.teams.filter(t=>t.championshipId===c.id).map(t=>t.playerId).filter(Boolean);db.championships=db.championships.filter(x=>x.id!==c.id);db.teams=db.teams.filter(t=>t.championshipId!==c.id);db.participations=db.participations.filter(x=>x.championshipId!==c.id);db.phases=db.phases.filter(x=>x.championshipId!==c.id);db.matches=db.matches.filter(m=>m.championshipId!==c.id);db.submissions=db.submissions.filter(s=>s.championshipId!==c.id&&!tids.includes(s.teamId));db.notifications=db.notifications.filter(n=>n.championshipId!==c.id);db.joinRequests=(db.joinRequests||[]).filter(r=>r.championshipId!==c.id);db.celebrationViews=db.celebrationViews.filter(v=>v.championshipId!==c.id);db.titles=db.titles.filter(t=>t.championshipId!==c.id);for(const u of db.users){if(u.playerId&&pids.includes(u.playerId)){const other=db.participations.some(x=>x.playerId===u.playerId);if(other)u.teamId=db.teams.find(t=>t.playerId===u.playerId)?.id||null;else u.teamId=null;}}writeDb(db);res.json({ok:true});});

app.get('/api/championships/:cid/matches',auth,(req,res)=>{const db=readDb();res.json(db.matches.filter(m=>m.championshipId===req.params.cid).map(m=>publicMatch(db,m)));});
app.get('/api/championships/:cid/standings',auth,(req,res)=>{const db=readDb(),c=championship(db,req.params.cid);if(!c)return res.status(404).json({error:'Campeonato não encontrado.'});const groups=db.phases.find(p=>p.championshipId===c.id&&p.type==='groups');if(c.format==='groups_knockout'||groups)return res.json({A:standings(db,c.id,'A',groups?.id),B:standings(db,c.id,'B',groups?.id),overall:standings(db,c.id, null, groups?.id),podium:c.podium||[]});res.json({league:standings(db,c.id,null,db.phases.find(p=>p.championshipId===c.id&&p.type==='league')?.id),podium:c.podium||[]});});
app.get('/api/version',(req,res)=>res.json({name:'Champions Amigos API',version:'6.1.0',build:'inscricoes-reactivacao-vagas'}));
app.get('/api/championships/:cid/overview',auth,(req,res)=>{const db=migrateLegacy(readDb()),c=championship(db,req.params.cid);if(!c)return res.status(404).json({error:'Campeonato não encontrado.'});finishLeagueIfComplete(db,c);ensureChampionship(c);const allMs=db.matches.filter(m=>m.championshipId===c.id),ms=allMs.filter(m=>m.status!=='bye'),table=standings(db,c.id),confirmed=ms.filter(m=>m.status==='confirmed').length,disputed=ms.filter(m=>m.status==='disputed').length,pending=ms.filter(m=>!['confirmed','disputed'].includes(m.status)),reg=registrationStats(db,c);writeDb(db);res.json({championship:c,registration:{maxParticipants:reg.max,confirmedParticipants:reg.confirmed,pendingParticipants:reg.pending,availableSlots:reg.available,full:reg.full},stats:{matches:ms.length,confirmed,disputed,pending:pending.length,progress:ms.length?Math.round(confirmed/ms.length*100):0},standings:table,podium:c.podium||[],leaders:table.slice(0,3),relegated:table.slice(Math.max(0,table.length-2)),phases:db.phases.filter(p=>p.championshipId===c.id),admin:adminPublic(db)});});
app.get('/api/championships/:cid/bracket',auth,(req,res)=>{const db=readDb();res.json(db.phases.filter(p=>p.championshipId===req.params.cid).sort((a,b)=>a.order-b.order).map(p=>({...p,matches:phaseMatches(db,req.params.cid,p.id).map(m=>publicMatch(db,m))})));});
app.get('/api/my/matches',auth,(req,res)=>{const db=migrateLegacy(readDb()),ts=userTeams(db,req.user.id).map(t=>t.id);res.json(db.matches.filter(m=>m.status!=='bye'&&(ts.includes(m.homeTeamId)||ts.includes(m.awayTeamId))).map(m=>publicMatch(db,m)));});
function submitResult(db,m,user,hs,as){const ts=userTeams(db,user.id).map(t=>t.id);if(!ts.includes(m.homeTeamId)&&!ts.includes(m.awayTeamId))return {error:'Você não pode lançar este jogo.'};if(m.status==='confirmed'||m.status==='bye'||m.resultType==='wo')return {error:'Esta partida já está encerrada.'};const tid=ts.includes(m.homeTeamId)?m.homeTeamId:m.awayTeamId;m.submissions ||= {};m.submissions[tid]={homeScore:hs,awayScore:as,at:now()};const vals=Object.values(m.submissions);if(vals.length>=2&&vals[0].homeScore===vals[1].homeScore&&vals[0].awayScore===vals[1].awayScore){m.homeScore=hs;m.awayScore=as;m.status='confirmed';m.resultType='normal';m.winnerTeamId=hs>as?m.homeTeamId:as>hs?m.awayTeamId:null;}else if(vals.length>=2){m.status='disputed';notification(db,{type:'dispute',title:'Resultado divergente',message:`Resultado divergente na partida ${teamName(db,m.homeTeamId)} x ${teamName(db,m.awayTeamId)}.`,championshipId:m.championshipId,matchId:m.id});}else m.status='waiting_confirmation';return null;}
app.post('/api/matches/:mid/submit',auth,(req,res)=>{const db=readDb(),m=db.matches.find(x=>x.id===req.params.mid),u=db.users.find(x=>x.id===req.user.id);if(!m||!u)return res.status(404).json({error:'Partida não encontrada.'});const hs=Number(req.body.homeScore),as=Number(req.body.awayScore);if(!Number.isInteger(hs)||!Number.isInteger(as)||hs<0||as<0)return res.status(400).json({error:'Placar inválido.'});const err=submitResult(db,m,u,hs,as);if(err)return res.status(400).json(err);finishLeagueIfComplete(db,championship(db,m.championshipId));writeDb(db);res.json(publicMatch(db,m));});
app.post('/api/matches/:mid/confirm',auth,(req,res)=>{const db=readDb(),m=db.matches.find(x=>x.id===req.params.mid),u=db.users.find(x=>x.id===req.user.id);if(!m||!u)return res.status(404).json({error:'Partida não encontrada.'});const ts=userTeams(db,u.id).map(t=>t.id),tid=ts.includes(m.homeTeamId)?m.homeTeamId:ts.includes(m.awayTeamId)?m.awayTeamId:null;if(!tid||m.status!=='waiting_confirmation')return res.status(400).json({error:'Confirmação indisponível.'});const other=Object.keys(m.submissions||{})[0];if(other===tid)return res.status(400).json({error:'A confirmação deve ser feita pelo adversário.'});const r=m.submissions[other];m.submissions[tid]={...r,confirmedAt:now()};m.homeScore=r.homeScore;m.awayScore=r.awayScore;m.status='confirmed';m.resultType='normal';m.winnerTeamId=r.homeScore>r.awayScore?m.homeTeamId:r.awayScore>r.homeScore?m.awayTeamId:null;finishLeagueIfComplete(db,championship(db,m.championshipId));writeDb(db);res.json(publicMatch(db,m));});
app.post('/api/matches/:mid/admin-result',auth,adminOnly,(req,res)=>{const db=readDb(),m=db.matches.find(x=>x.id===req.params.mid);if(!m)return res.status(404).json({error:'Partida não encontrada.'});const hs=Number(req.body.homeScore),as=Number(req.body.awayScore);if(!Number.isInteger(hs)||!Number.isInteger(as)||hs<0||as<0)return res.status(400).json({error:'Placar inválido.'});m.homeScore=hs;m.awayScore=as;m.status='confirmed';m.resultType='admin';m.adminOverride=true;m.winnerTeamId=hs>as?m.homeTeamId:as>hs?m.awayTeamId:null;m.adminNote=req.body.note||null;finishLeagueIfComplete(db,championship(db,m.championshipId));writeDb(db);res.json(publicMatch(db,m));});
app.post('/api/matches/:mid/wo',auth,adminOnly,(req,res)=>{const db=readDb(),m=db.matches.find(x=>x.id===req.params.mid);if(!m)return res.status(404).json({error:'Partida não encontrada.'});const loser=req.body.loserTeamId,winner=loser===m.homeTeamId?m.awayTeamId:m.homeTeamId;if(!winner||![m.homeTeamId,m.awayTeamId].includes(loser))return res.status(400).json({error:'Participante inválido.'});const g=Math.max(1,Number(req.body.goals)||3);m.homeScore=winner===m.homeTeamId?g:0;m.awayScore=winner===m.awayTeamId?g:0;m.winnerTeamId=winner;m.status='confirmed';m.resultType='wo';m.adminNote=req.body.note||'W.O. aplicado pelo ADM';finishLeagueIfComplete(db,championship(db,m.championshipId));writeDb(db);res.json(publicMatch(db,m));});



app.listen(PORT,()=>console.log(`Champions Amigos API running on http://localhost:${PORT}`));
