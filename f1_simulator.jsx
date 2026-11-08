﻿/**
 * F1 SIM 2027 â€” Formula 1 Season Simulator
 * React 19 JSX, single-file PWA, localStorage persistence
 * Commentary via Anthropic claude-sonnet-4
 */

import { useState, useRef } from "react";

// ===================== DATA =====================


// â”€â”€ Car stats are set directly on each team via sliders â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Fields: carPace, reliability, pitSpeed, tyreLife, cornering, topSpeed

// (PARTS catalogue removed â€” stats are now set directly via sliders)

// Derive effective team stats â€” reads direct slider fields
// Returns { carPace, reliability, pitSpeed, tyreLife, wetBonus, cornerBonus, straightBonus }
function getTeamStats(team) {
  const carPace     = team.carPace     ?? 75;
  const reliability = team.reliability ?? 75;
  const pitSpeed    = team.pitSpeed    ?? (team.basePitSpeed || 80);
  const tyreLife    = team.tyreLife    ?? 65;
  const cornering   = team.cornering   ?? 10;
  const topSpeed    = team.topSpeed    ?? 10;
  // Small wet bonus derived from tyre management ability
  const wetBonus    = Math.round((tyreLife - 65) / 5);
  return {
    carPace,
    reliability,
    pitSpeed,
    tyreLife,
    wetBonus,
    cornerBonus:   cornering * 1.5,
    straightBonus: topSpeed  * 1.2,
    aeroCircuitBonus: {},
  };
}

const TEAMS = [
  // Stats based on 2025/2026 IRL performance
  // carPace(55-99) · reliability(55-99) · pitSpeed(70-99) · tyreLife(40-90) · cornering(1-20) · topSpeed(1-20)
  {id:"mclaren",    tier:"top", strategy:"aggressive_two", name:"McLaren",      abbr:"MCL",color:"#FF8000",tc:"#000",basePitSpeed:92, carPace:96, reliability:88, pitSpeed:92, tyreLife:82, cornering:18, topSpeed:14},
  {id:"ferrari",    tier:"top", strategy:"overcut",        name:"Ferrari",      abbr:"FER",color:"#E8002D",tc:"#fff",basePitSpeed:87, carPace:93, reliability:84, pitSpeed:87, tyreLife:76, cornering:16, topSpeed:16},
  {id:"redbull",    tier:"top", strategy:"one_stop",       name:"Red Bull",     abbr:"RBR",color:"#3671C6",tc:"#fff",basePitSpeed:95, carPace:91, reliability:83, pitSpeed:95, tyreLife:79, cornering:16, topSpeed:15},
  {id:"mercedes",   tier:"top", strategy:"undercut_king",  name:"Mercedes",     abbr:"MER",color:"#00D2BE",tc:"#000",basePitSpeed:88, carPace:89, reliability:91, pitSpeed:88, tyreLife:83, cornering:14, topSpeed:14},
  {id:"williams",   tier:"mid", strategy:"fuel_save",      name:"Williams",     abbr:"WIL",color:"#37BEDD",tc:"#000",basePitSpeed:83, carPace:82, reliability:82, pitSpeed:83, tyreLife:78, cornering:11, topSpeed:13},
  {id:"racingbulls",tier:"mid", strategy:"reactive",       name:"Racing Bulls", abbr:"RBX",color:"#6692FF",tc:"#fff",basePitSpeed:84, carPace:81, reliability:79, pitSpeed:84, tyreLife:74, cornering:12, topSpeed:13},
  {id:"astonmartin",tier:"mid", strategy:"safety_car",     name:"Aston Martin", abbr:"AMR",color:"#358C75",tc:"#fff",basePitSpeed:82, carPace:79, reliability:80, pitSpeed:82, tyreLife:75, cornering:12, topSpeed:12},
  {id:"alpine",     tier:"mid", strategy:"reactive",       name:"Alpine",       abbr:"ALP",color:"#0093CC",tc:"#fff",basePitSpeed:79, carPace:77, reliability:77, pitSpeed:79, tyreLife:72, cornering:10, topSpeed:12},
  {id:"haas",       tier:"low", strategy:"tyre_banker",    name:"Haas",         abbr:"HAS",color:"#B6BABD",tc:"#000",basePitSpeed:80, carPace:75, reliability:76, pitSpeed:80, tyreLife:71, cornering:10, topSpeed:11},
  {id:"audi",       tier:"low", strategy:"one_stop",       name:"Audi",         abbr:"AUD",color:"#B30000",tc:"#fff",basePitSpeed:78, carPace:71, reliability:72, pitSpeed:78, tyreLife:66, cornering:9,  topSpeed:10},
  {id:"cadillac",   tier:"low", strategy:"fuel_save",      name:"Cadillac",     abbr:"CAD",color:"#6B6B6B",tc:"#fff",basePitSpeed:76, carPace:67, reliability:70, pitSpeed:76, tyreLife:62, cornering:8,  topSpeed:9},
];




// â”€â”€ Budget tier configuration â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const TIER_CONFIG = {
  top: {label:"TOP TEAM",   color:"#E8002D", startCap:25, capPerRound:6, desc:"Leading constructor · Full factory resources"},
  mid: {label:"MID-FIELD",  color:"#FFC906", startCap:15, capPerRound:4, desc:"Independent constructor · Focused development"},
  low: {label:"BACKMARKER", color:"#778899", startCap:12, capPerRound:2, desc:"New or developing team · Limited budget"},
};

function initBudgets() {
  return Object.fromEntries(TEAMS.map(t=>[t.id, (TIER_CONFIG[t.tier]||TIER_CONFIG.low).startCap]));
}

// â•‘  Defines 8 race strategy archetypes. Each strategy carries numeric      â•‘
// â•‘  directly into runRace() and runSprint(). Teams are assigned a default  â•‘
// â•‘                                                                          â•‘
// â•‘  Overcut Gamble · Fuel Saving Mode · Safety Car Hunter · Tyre Banker    â•‘
// ===================== TEAM STRATEGIES =====================
const TEAM_STRATEGIES = [
  {
    id:"one_stop",    name:"One-Stop Master",  icon:"ðŸŽ¯", color:"#44CC88",
    desc:"Commit to a single pit stop. Maximise track position, nurse tyres to the end.",
    effects:"Pit stops: 1 · Tyre deg management +15% · Position gain from undercut âˆ’80% · Effective when safety car unlikely",
    mods:{pitStops:1,tyreBonus:1.15,undercutPenalty:0.2,overallPace:0.98,dnfRisk:-0.03,scBonus:1.2},
    lapNotes:["Managing the rubber carefully","Trying to make it to the end on this set","The long stints will define their race"],
  },
  {
    id:"aggressive_two","name":"Aggressive 2-Stop",icon:"ðŸ”¥",color:"#FF4444",
    desc:"Go fast, go often. Two stops, always on fresh rubber, always hunting the gap.",
    effects:"Pit stops: 2 · Lap pace +4% · Undercut attack +30% · Tyre degradation ignored · High DNF risk",
    mods:{pitStops:2,tyreBonus:0.96,undercutPenalty:1.3,overallPace:1.04,dnfRisk:0.06,scBonus:0.9},
    lapNotes:["Pushing hard on fresh rubber","The pace is there â€” question is whether the car survives","Attack, attack, attack"],
  },
  {
    id:"undercut_king","name":"Undercut Specialist",icon:"âš”ï¸",color:"#E8002D",
    desc:"Always first to blink. Pit early, undercut the rival, use the fresh tyre delta to take the place.",
    effects:"Undercut efficiency +40% · Pit timing perfect · Overtaking on track âˆ’30% · Requires clean airspace post-stop",
    mods:{pitStops:2,tyreBonus:1.0,undercutPenalty:1.4,overallPace:1.01,dnfRisk:0.02,scBonus:1.15},
    lapNotes:["Box this lap â€” undercut window is open","Out on fresh tyres, they need to deliver now","The out-lap will define this entire race"],
  },
  {
    id:"overcut",     name:"Overcut Gamble",    icon:"â™Ÿï¸",color:"#BB66FF",
    desc:"Stay out longer than everyone else. Bank the track position, make rivals come to you.",
    effects:"Track position premium +20% · Later pitstop · Tyre pace degrades · Only works if traffic not an issue",
    mods:{pitStops:1,tyreBonus:0.92,undercutPenalty:0.6,overallPace:0.99,dnfRisk:0.01,scBonus:1.3},
    lapNotes:["Staying out â€” the overcut is the plan","Old tyres, but track position is priceless here","They need the safety car to make this work"],
  },
  {
    id:"fuel_save",   name:"Fuel Saving Mode",  icon:"ðŸ’§",color:"#4488FF",
    desc:"Drop engine modes, save fuel, target a race-shaping deployment in the final stint.",
    effects:"Final 20 laps pace +6% · First 60% of race pace âˆ’3% · DNF risk âˆ’25% · Excellent for unpredictable races",
    mods:{pitStops:1,tyreBonus:1.05,undercutPenalty:0.8,overallPace:0.97,dnfRisk:-0.25,scBonus:1.1,lateBoost:1.06},
    lapNotes:["Saving fuel in the early phase","Targets are in the window â€” they'll deploy later","Patient race â€” the sting is in the tail"],
  },
  {
    id:"safety_car",  name:"Safety Car Hunter", icon:"ðŸš—",color:"#FFC906",
    desc:"Build a big gap, pit early under green, let a safety car close it back up for free.",
    effects:"Pre-SC track position value +25% · Safety car timing bonus · Very high variance · Nothing happens without SC",
    mods:{pitStops:1,tyreBonus:1.1,undercutPenalty:0.5,overallPace:0.99,dnfRisk:-0.02,scBonus:1.5},
    lapNotes:["Waiting for the safety car window","Pitting very early â€” banking on a SC to close the gap","If the safety car doesn't come, this race is over"],
  },
  {
    id:"tyre_banker", name:"Tyre Banker",       icon:"ðŸ¦",color:"#FF8844",
    desc:"Qualify on softs, start race on used tyres, pit for a new set while rivals are struggling.",
    effects:"Stint 1 pace âˆ’5% · Stint 2 pace +8% (fresh vs degraded) · Qualifying tyre preserved · Complex to execute",
    mods:{pitStops:2,tyreBonus:1.08,undercutPenalty:1.2,overallPace:1.0,dnfRisk:0.01,scBonus:0.95},
    lapNotes:["Used tyres in the first stint by design","They're banking tyre life for later","The gap to fresher tyres will tell the real story"],
  },
  {
    id:"reactive",    name:"Reactive Strategy", icon:"ðŸ”„",color:"#00D2BE",
    desc:"No fixed plan. Pit crew ready for anything. React to safety cars, rivals, and track conditions.",
    effects:"Safety car reaction speed +35% · VSC pitstop efficiency +20% · Can execute any strategy mid-race · Slight execution risk",
    mods:{pitStops:2,tyreBonus:1.02,undercutPenalty:1.1,overallPace:1.0,dnfRisk:0.0,scBonus:1.35},
    lapNotes:["Keeping all options open","They'll react to whatever the race throws at them","The strategy call will be made lap by lap"],
  },
];

function getTeamStrategy(team) {
  return TEAM_STRATEGIES.find(s=>s.id===team.strategy)||TEAM_STRATEGIES[1];
}

// Known rivalries for richer narrative

// â•‘  Rivals are stored per-driver as rivals:[] arrays. getRivalry() checks  â•‘
// â•‘  description string used in qualifying, sprint and race narratives.     â•‘
/**
 * Returns a rivalry object if dA and dB have a mutual rivalry set.
 * @param {object} dA - First driver object (with .rivals array)
 * @param {object} dB - Second driver object
 * @returns {{a:string, b:string, desc:string}|null}
 */
function getRivalry(dA, dB, allDrivers) {
  // Check if either driver has the other listed as a rival
  const aRivals = dA.rivals || [];
  const bRivals = dB.rivals || [];
  if(!aRivals.includes(dB.id) && !bRivals.includes(dA.id)) return null;
  // Build a dynamic description from driver context
  const sameTeam = dA.teamId === dB.teamId;
  const descs = sameTeam ? [
    `the ${dA.name.split(" ").pop()}/${dB.name.split(" ").pop()} team-mate battle`,
    `the internal team war between ${dA.name.split(" ").pop()} and ${dB.name.split(" ").pop()}`,
    `the ${dA.name.split(" ").pop()}-${dB.name.split(" ").pop()} intra-team duel`,
  ] : [
    `the ${dA.name.split(" ").pop()}-${dB.name.split(" ").pop()} rivalry`,
    `the battle between ${dA.name.split(" ").pop()} and ${dB.name.split(" ").pop()}`,
    `the ${dA.name.split(" ").pop()}/${dB.name.split(" ").pop()} championship fight`,
  ];
  return { a: dA.id, b: dB.id, desc: _pick(descs) };
}

const DRIVERS = [
  {id:"norris",   name:"Lando Norris",    abbr:"NOR",num:4, teamId:"mclaren",    pace:94,consistency:90,wet:88,overtaking:91,defense:87,experience:82,mental:8, flag:"ðŸ‡¬ðŸ‡§",goodTracks:["britain","belgium","usa"],       badTracks:["monaco","singapore","hungary"],style:"charger",rivals:["verstappen","leclerc"]},
  {id:"piastri",  name:"Oscar Piastri",   abbr:"PIA",num:81,teamId:"mclaren",    pace:91,consistency:88,wet:85,overtaking:87,defense:84,experience:76,mental:8, flag:"ðŸ‡¦ðŸ‡º",goodTracks:["australia","japan","miami"],     badTracks:["monaco","canada","azerbaijan"],style:"technical",rivals:["norris","russell"]},
  {id:"russell",  name:"George Russell",  abbr:"RUS",num:63,teamId:"mercedes",   pace:90,consistency:89,wet:87,overtaking:85,defense:86,experience:78,mental:8, flag:"ðŸ‡¬ðŸ‡§",goodTracks:["britain","belgium","brazil"],    badTracks:["monaco","azerbaijan","lasvegas"],style:"technical",rivals:["antonelli","norris"]},
  {id:"antonelli",name:"Kimi Antonelli",  abbr:"ANT",num:12,teamId:"mercedes",   pace:86,consistency:82,wet:80,overtaking:83,defense:79,experience:60,mental:6, flag:"ðŸ‡®ðŸ‡¹",goodTracks:["italy","china","bahrain"],       badTracks:["monaco","singapore","canada"],style:"qualifier",rivals:["russell","hadjar"]},
  {id:"verstappen",name:"Max Verstappen", abbr:"VER",num:1, teamId:"redbull",    pace:97,consistency:95,wet:96,overtaking:96,defense:94,experience:92,mental:9, flag:"ðŸ‡³ðŸ‡±",goodTracks:["japan","belgium","brazil"],      badTracks:["singapore","monaco","hungary"],style:"aggressive",rivals:["norris","leclerc"]},
  {id:"hadjar",   name:"Isack Hadjar",    abbr:"HAD",num:6, teamId:"redbull",    pace:84,consistency:80,wet:78,overtaking:81,defense:78,experience:58,mental:6, flag:"ðŸ‡«ðŸ‡·",goodTracks:["bahrain","spain","austria"],     badTracks:["monaco","singapore","lasvegas"],style:"aggressive",rivals:["lawson","antonelli"]},
  {id:"leclerc",  name:"Charles Leclerc", abbr:"LEC",num:16,teamId:"ferrari",    pace:92,consistency:87,wet:88,overtaking:89,defense:86,experience:82,mental:7, flag:"ðŸ‡²ðŸ‡¨",goodTracks:["monaco","azerbaijan","italy"],   badTracks:["hungary","brazil","japan"],style:"qualifier",rivals:["hamilton","verstappen"]},
  {id:"hamilton", name:"Lewis Hamilton",  abbr:"HAM",num:44,teamId:"ferrari",    pace:88,consistency:86,wet:90,overtaking:88,defense:88,experience:99,mental:9, flag:"ðŸ‡¬ðŸ‡§",goodTracks:["britain","hungary","spain"],     badTracks:["azerbaijan","lasvegas","qatar"],style:"smooth",rivals:["leclerc","alonso"]},
  {id:"sainz",    name:"Carlos Sainz",    abbr:"SAI",num:55,teamId:"williams",   pace:87,consistency:88,wet:85,overtaking:84,defense:85,experience:86,mental:8, flag:"ðŸ‡ªðŸ‡¸",goodTracks:["singapore","spain","australia"], badTracks:["hungary","brazil","abudhabi"],style:"smooth",rivals:["albon","leclerc"]},
  {id:"albon",    name:"Alex Albon",      abbr:"ALB",num:23,teamId:"williams",   pace:82,consistency:83,wet:80,overtaking:80,defense:82,experience:74,mental:7, flag:"ðŸ‡¹ðŸ‡­",goodTracks:["miami","usa","australia"],       badTracks:["monaco","singapore","brazil"],style:"defender",rivals:["sainz"]},
  {id:"lawson",   name:"Liam Lawson",     abbr:"LAW",num:30,teamId:"racingbulls",pace:80,consistency:78,wet:77,overtaking:79,defense:76,experience:66,mental:7, flag:"ðŸ‡³ðŸ‡¿",goodTracks:["japan","china","bahrain"],       badTracks:["monaco","singapore","austria"],style:"technical",rivals:["hadjar","lindblad"]},
  {id:"lindblad", name:"Arvid Lindblad",  abbr:"LIN",num:7, teamId:"racingbulls",pace:74,consistency:72,wet:70,overtaking:73,defense:70,experience:40,mental:5, flag:"ðŸ‡¬ðŸ‡§",goodTracks:["britain","austria","bahrain"],   badTracks:["monaco","singapore","italy"],style:"qualifier",rivals:["lawson"]},
  {id:"alonso",   name:"Fernando Alonso", abbr:"ALO",num:14,teamId:"astonmartin",pace:88,consistency:90,wet:92,overtaking:89,defense:91,experience:99,mental:10,flag:"ðŸ‡ªðŸ‡¸",goodTracks:["monaco","hungary","spain"],      badTracks:["azerbaijan","lasvegas","canada"],style:"strategist",rivals:["hamilton","verstappen"]},
  {id:"stroll",   name:"Lance Stroll",    abbr:"STR",num:18,teamId:"astonmartin",pace:72,consistency:70,wet:73,overtaking:68,defense:72,experience:72,mental:6, flag:"ðŸ‡¨ðŸ‡¦",goodTracks:["azerbaijan","bahrain","saudi"],  badTracks:["monaco","hungary","brazil"],style:"defender",rivals:["alonso"]},
  {id:"bearman",  name:"Oliver Bearman",  abbr:"BEA",num:87,teamId:"haas",       pace:78,consistency:76,wet:74,overtaking:76,defense:74,experience:58,mental:7, flag:"ðŸ‡¬ðŸ‡§",goodTracks:["italy","britain","miami"],       badTracks:["monaco","singapore","japan"],style:"aggressive",rivals:["ocon"]},
  {id:"ocon",     name:"Esteban Ocon",    abbr:"OCO",num:31,teamId:"haas",       pace:79,consistency:77,wet:79,overtaking:76,defense:78,experience:78,mental:7, flag:"ðŸ‡«ðŸ‡·",goodTracks:["hungary","australia","spain"],   badTracks:["monaco","azerbaijan","lasvegas"],style:"ironman",rivals:["bearman","gasly"]},
  {id:"hulkenberg",name:"Nico HÃ¼lkenberg",abbr:"HUL",num:27,teamId:"audi",       pace:80,consistency:82,wet:78,overtaking:77,defense:80,experience:90,mental:8, flag:"ðŸ‡©ðŸ‡ª",goodTracks:["austria","spain","brazil"],     badTracks:["monaco","singapore","italy"],style:"ironman",rivals:["bortoleto"]},
  {id:"bortoleto",name:"Gabriel Bortoleto",abbr:"BOR",num:5,teamId:"audi",       pace:76,consistency:74,wet:73,overtaking:75,defense:72,experience:52,mental:6, flag:"ðŸ‡§ðŸ‡·",goodTracks:["brazil","spain","usa"],         badTracks:["monaco","singapore","azerbaijan"],style:"charger",rivals:["hulkenberg"]},
  {id:"gasly",    name:"Pierre Gasly",    abbr:"GAS",num:10,teamId:"alpine",     pace:79,consistency:78,wet:77,overtaking:78,defense:77,experience:80,mental:7, flag:"ðŸ‡«ðŸ‡·",goodTracks:["italy","bahrain","spain"],       badTracks:["monaco","singapore","hungary"],style:"charger",rivals:["colapinto","ocon"]},
  {id:"colapinto",name:"Franco Colapinto",abbr:"COL",num:43,teamId:"alpine",     pace:76,consistency:74,wet:74,overtaking:75,defense:73,experience:55,mental:7, flag:"ðŸ‡¦ðŸ‡·",goodTracks:["lasvegas","brazil","miami"],     badTracks:["monaco","singapore","japan"],style:"aggressive",rivals:["gasly"]},
  {id:"perez",    name:"Sergio PÃ©rez",    abbr:"PER",num:11,teamId:"cadillac",   pace:78,consistency:77,wet:76,overtaking:76,defense:78,experience:88,mental:6, flag:"ðŸ‡²ðŸ‡½",goodTracks:["azerbaijan","saudi","singapore"],badTracks:["monaco","hungary","brazil"],style:"strategist",rivals:["bottas"]},
  {id:"bottas",   name:"Valtteri Bottas", abbr:"BOT",num:77,teamId:"cadillac",   pace:74,consistency:75,wet:74,overtaking:72,defense:74,experience:86,mental:7, flag:"ðŸ‡«ðŸ‡®",goodTracks:["austria","japan","spain"],       badTracks:["monaco","azerbaijan","lasvegas"],style:"ironman",rivals:["perez"]},
];

const TRACKS = [
  // id           name                     circuit                           flag  laps od  td  wr  type               sprint drs corners alt  temp abrasive pitDelta night lapLen topSpeed downforce street
  {id:"australia", name:"Australian GP",    circuit:"Albert Park",           flag:"ðŸ‡¦ðŸ‡º",laps:58,od:45,td:60,wr:30,type:"mixed",         hasSprint:false,drs:4,corners:16,alt:10,  temp:21,abrasive:4,pitDelta:23,night:false,lapLen:5.28,topSpeed:318,downforce:6,street:false},
  {id:"china",     name:"Chinese GP",       circuit:"Shanghai Int'l",       flag:"ðŸ‡¨ðŸ‡³",laps:56,od:40,td:65,wr:40,type:"mixed",         hasSprint:true, drs:2,corners:16,alt:5,   temp:16,abrasive:3,pitDelta:24,night:false,lapLen:5.45,topSpeed:327,downforce:6,street:false},
  {id:"japan",     name:"Japanese GP",      circuit:"Suzuka",                flag:"ðŸ‡¯ðŸ‡µ",laps:53,od:60,td:55,wr:50,type:"high-speed",    hasSprint:false,drs:2,corners:18,alt:40,  temp:15,abrasive:4,pitDelta:25,night:false,lapLen:5.81,topSpeed:330,downforce:7,street:false},
  {id:"bahrain",   name:"Bahrain GP",       circuit:"Bahrain Int'l",        flag:"ðŸ‡§ðŸ‡­",laps:57,od:40,td:68,wr:5, type:"technical",     hasSprint:false,drs:3,corners:15,alt:7,   temp:30,abrasive:7,pitDelta:22,night:true, lapLen:5.41,topSpeed:322,downforce:6,street:false},
  {id:"saudi",     name:"Saudi Arabian GP", circuit:"Jeddah Corniche",       flag:"ðŸ‡¸ðŸ‡¦",laps:50,od:30,td:58,wr:5, type:"street",        hasSprint:false,drs:3,corners:27,alt:10,  temp:28,abrasive:2,pitDelta:21,night:true, lapLen:6.17,topSpeed:340,downforce:5,street:true },
  {id:"miami",     name:"Miami GP",         circuit:"Miami Int'l Autodrome",flag:"ðŸ‡ºðŸ‡¸",laps:57,od:50,td:70,wr:35,type:"street",        hasSprint:true, drs:3,corners:19,alt:2,   temp:28,abrasive:3,pitDelta:24,night:false,lapLen:5.41,topSpeed:320,downforce:6,street:true },
  {id:"spain",     name:"Spanish GP",       circuit:"Circuit de Barcelona",  flag:"ðŸ‡ªðŸ‡¸",laps:66,od:55,td:72,wr:25,type:"high-downforce",hasSprint:false,drs:2,corners:16,alt:110, temp:24,abrasive:4,pitDelta:24,night:false,lapLen:4.66,topSpeed:315,downforce:8,street:false},
  {id:"monaco",    name:"Monaco GP",        circuit:"Circuit de Monaco",     flag:"ðŸ‡²ðŸ‡¨",laps:78,od:88,td:40,wr:30,type:"street",        hasSprint:false,drs:1,corners:19,alt:15,  temp:20,abrasive:2,pitDelta:27,night:false,lapLen:3.34,topSpeed:290,downforce:8,street:true },
  {id:"canada",    name:"Canadian GP",      circuit:"Gilles Villeneuve",     flag:"ðŸ‡¨ðŸ‡¦",laps:70,od:25,td:68,wr:45,type:"street",        hasSprint:false,drs:2,corners:14,alt:12,  temp:22,abrasive:2,pitDelta:22,night:false,lapLen:4.36,topSpeed:330,downforce:5,street:true },
  {id:"madrid",    name:"Madrid GP",        circuit:"IFEMA Madrid",          flag:"ðŸ‡ªðŸ‡¸",laps:55,od:45,td:65,wr:20,type:"street",        hasSprint:false,drs:3,corners:20,alt:665, temp:28,abrasive:3,pitDelta:23,night:false,lapLen:5.47,topSpeed:325,downforce:6,street:true },
  {id:"austria",   name:"Austrian GP",      circuit:"Red Bull Ring",         flag:"ðŸ‡¦ðŸ‡¹",laps:71,od:35,td:55,wr:40,type:"high-speed",    hasSprint:true, drs:3,corners:10,alt:680, temp:22,abrasive:3,pitDelta:21,night:false,lapLen:4.32,topSpeed:319,downforce:5,street:false},
  {id:"britain",   name:"British GP",       circuit:"Silverstone",           flag:"ðŸ‡¬ðŸ‡§",laps:52,od:40,td:70,wr:60,type:"high-speed",    hasSprint:false,drs:2,corners:18,alt:126, temp:18,abrasive:4,pitDelta:23,night:false,lapLen:5.89,topSpeed:330,downforce:7,street:false},
  {id:"hungary",   name:"Hungarian GP",     circuit:"Hungaroring",           flag:"ðŸ‡­ðŸ‡º",laps:70,od:65,td:55,wr:40,type:"technical",     hasSprint:false,drs:2,corners:14,alt:260, temp:30,abrasive:3,pitDelta:23,night:false,lapLen:4.38,topSpeed:305,downforce:9,street:false},
  {id:"belgium",   name:"Belgian GP",       circuit:"Spa-Francorchamps",     flag:"ðŸ‡§ðŸ‡ª",laps:44,od:30,td:60,wr:70,type:"high-speed",    hasSprint:false,drs:2,corners:19,alt:435, temp:17,abrasive:4,pitDelta:24,night:false,lapLen:7.00,topSpeed:340,downforce:5,street:false},
  {id:"netherlands",name:"Dutch GP",        circuit:"Zandvoort",             flag:"ðŸ‡³ðŸ‡±",laps:72,od:65,td:65,wr:45,type:"technical",     hasSprint:false,drs:2,corners:14,alt:5,   temp:18,abrasive:5,pitDelta:22,night:false,lapLen:4.26,topSpeed:320,downforce:8,street:false},
  {id:"italy",     name:"Italian GP",       circuit:"Monza",                 flag:"ðŸ‡®ðŸ‡¹",laps:53,od:20,td:45,wr:30,type:"low-downforce", hasSprint:false,drs:2,corners:11,alt:162, temp:24,abrasive:3,pitDelta:23,night:false,lapLen:5.79,topSpeed:360,downforce:2,street:false},
  {id:"azerbaijan",name:"Azerbaijan GP",    circuit:"Baku City Circuit",     flag:"ðŸ‡¦ðŸ‡¿",laps:51,od:22,td:55,wr:15,type:"street",        hasSprint:false,drs:2,corners:20,alt:28,  temp:25,abrasive:2,pitDelta:21,night:false,lapLen:6.00,topSpeed:340,downforce:4,street:true },
  {id:"singapore", name:"Singapore GP",     circuit:"Marina Bay",            flag:"ðŸ‡¸ðŸ‡¬",laps:61,od:72,td:70,wr:50,type:"street",        hasSprint:false,drs:3,corners:23,alt:15,  temp:32,abrasive:3,pitDelta:27,night:true, lapLen:5.06,topSpeed:300,downforce:9,street:true },
  {id:"usa",       name:"United States GP", circuit:"Circuit of the Americas",flag:"ðŸ‡ºðŸ‡¸",laps:56,od:40,td:65,wr:35,type:"mixed",        hasSprint:true, drs:2,corners:20,alt:300, temp:28,abrasive:5,pitDelta:24,night:false,lapLen:5.51,topSpeed:325,downforce:7,street:false},
  {id:"mexico",    name:"Mexican GP",       circuit:"Autodromo HR",          flag:"ðŸ‡²ðŸ‡½",laps:71,od:45,td:50,wr:25,type:"technical",     hasSprint:false,drs:3,corners:17,alt:2285,temp:21,abrasive:3,pitDelta:25,night:false,lapLen:4.30,topSpeed:365,downforce:4,street:false},
  {id:"brazil",    name:"Brazilian GP",     circuit:"Interlagos",            flag:"ðŸ‡§ðŸ‡·",laps:71,od:30,td:60,wr:65,type:"mixed",         hasSprint:true, drs:2,corners:15,alt:785, temp:26,abrasive:4,pitDelta:23,night:false,lapLen:4.31,topSpeed:328,downforce:5,street:false},
  {id:"lasvegas",  name:"Las Vegas GP",     circuit:"Las Vegas Strip",       flag:"ðŸ‡ºðŸ‡¸",laps:50,od:35,td:55,wr:10,type:"street",        hasSprint:false,drs:3,corners:17,alt:640, temp:12,abrasive:2,pitDelta:22,night:true, lapLen:6.20,topSpeed:345,downforce:4,street:true },
  {id:"qatar",     name:"Qatar GP",         circuit:"Lusail Circuit",        flag:"ðŸ‡¶ðŸ‡¦",laps:57,od:45,td:75,wr:5, type:"technical",     hasSprint:true, drs:2,corners:16,alt:15,  temp:30,abrasive:8,pitDelta:24,night:true, lapLen:5.38,topSpeed:322,downforce:7,street:false},
  {id:"abudhabi",  name:"Abu Dhabi GP",     circuit:"Yas Marina",            flag:"ðŸ‡¦ðŸ‡ª",laps:58,od:45,td:50,wr:5, type:"mixed",         hasSprint:false,drs:2,corners:16,alt:3,   temp:28,abrasive:3,pitDelta:24,night:true, lapLen:5.28,topSpeed:332,downforce:6,street:false},
];

// Reference pole-position lap times in seconds (based on 2024/2025 data, adjusted for 2027 regs)
const QUAL_REFS = {
  australia:75.9, china:92.9, japan:88.2, bahrain:89.2, saudi:87.5,
  miami:87.2,     spain:71.4, monaco:70.3, canada:70.3, madrid:87.5,
  austria:64.3,   britain:84.4, hungary:74.4, belgium:101.4, netherlands:69.8,
  italy:79.4,     azerbaijan:101.4, singapore:89.5, usa:92.3, mexico:76.2,
  brazil:70.0,    lasvegas:91.1, qatar:83.8, abudhabi:82.6,
};

const PTS        = [25,18,15,12,10,8,6,4,2,1];
const SPRINT_PTS = [8,7,6,5,4,3,2,1];
const CPDS       = ["Softs","Mediums","Hards","Intermediates"];
const FAIL       = ["engine failure","hydraulics failure","gearbox failure","suspension damage","power unit issue","brake failure","water pressure loss"];
const PIT_DISASTERS = [
  {icon:"âš ï¸",type:"slowstop",label:"SLOW STOP",texts:["Tyre stuck on â€” {t}s lost!","Wheel gun issue â€” {t}s in the box!","Air gun failure â€” {t}s stationary!","Nut cross-threaded â€” {t}s lost!"]},
  {icon:"ðŸ’¥",type:"pitstop",label:"PIT NIGHTMARE",texts:["Lollipop error â€” released into traffic!","Wrong compound fitted â€” back to the box!","Unsafe release â€” five-second penalty incoming!","Front wing not secured â€” pit again next lap!"]},
  {icon:"âš ï¸",type:"strategy",label:"TYRE GAMBLE",texts:["Radical call â€” {cpd} tyres on? Bold.","Staying out on worn rubber â€” risky!","They're gambling on rain! Inters going on dry tyres.","Boxing early â€” going for the undercut on everyone!"]},
];
const EVT_C      = {incident:"#FF4444",dnf:"#FF6644",safetycar:"#FFC906",vsc:"#FFDD44",weather:"#4488FF",charge:"#44CC88",fastestlap:"#CC44FF",battle:"#FF8844",pitstop:"#44AAFF",slowstop:"#FF8800",drop:"#FF8844",start:"#E8002D",strategy:"#BB66FF",redflag:"#FF0000",damage:"#FF6600",sector:"#BB66FF"};

const OFF_TRACK_MSGS = [
  "{d} runs wide through turn {t} in {sec} â€” four wheels over the white line! Gravel scattered across the racing line.",
  "{d} locks up under braking and goes off at the chicane! Car bounces through the gravel trap.",
  "{d} loses the rear and spins â€” slides backwards into the gravel! Marshals on standby.",
  "{d} pushed wide by a rival and loses the car over the kerbs â€” gravel everywhere.",
  "{d} misjudges the entry and spears off into the gravel. Extraordinary save to keep it going.",
  "{d} half-pirouettes at the exit â€” tyres shredded by gravel, flat-spotted badly.",
];
const GRAVEL_MSGS = [
  "ðŸª¨ Gravel deposited at turn {t} in {sec} from {d}'s excursion â€” VIRTUAL SAFETY CAR DEPLOYED.",
  "ðŸª¨ Debris and gravel scattered across the racing line â€” stewards request a VSC period.",
  "ðŸª¨ Gravel brought onto the circuit. Track limits compromised â€” VSC called immediately.",
  "ðŸª¨ Significant gravel on the apex of turn {t} in {sec}. Marshals cannot clear without a VSC.",
];
const ENGINE_FAIL_MSGS = [
  "{d} has catastrophic ENGINE FAILURE â€” plume of white smoke from the rear! Car stops on track.",
  "{d} reports a sudden power loss â€” 'ENGINE, ENGINE!' on the radio. Car coasting to a halt.",
  "RETIREMENT: {d} â€” engine let go spectacularly on the main straight. Fire extinguisher deployed.",
  "{d} pulls over at turn {t} in {sec} â€” 'I've lost all power.' Engine gone. Race over for {abbr}.",
];
const DAMAGE_MSGS = [
  "{d} pits with significant front wing damage â€” something picked up from a kerb strike.",
  "{d} reports a PUNCTURE! Limping back to the pits on a destroyed tyre.",
  "{d}'s floor badly damaged after riding a kerb. Handling described as 'undriveable' on the radio.",
  "{d} has lost a rear wing endplate â€” must pit immediately. Aero balance destroyed.",
  "{d} reports brake-by-wire failure. Pitting for investigation â€” race effectively over.",
  "{d} with massive floor damage â€” generating sparks on every straight. Pace destroyed.",
];

const pick  = a => a[Math.floor(Math.random()*a.length)];
const pickN = (a,n) => [...a].sort(()=>Math.random()-0.5).slice(0,n);
const Lf    = (t,f) => Math.max(1,Math.floor(t*f));

// ===================== SIMULATION ENGINE =====================


const _pick=(a)=>a[Math.floor(Math.random()*a.length)];

// â•‘  8 driver style archetypes, each applying stat modifiers to the         â•‘
// â•‘  race pace (overallPace), DNF risk, overtaking/defense weighting.       â•‘
// â•‘  Styles: Aggressive · Smooth · Qualifier · Defender · Charger           â•‘

// ===================== DRIVING STYLES =====================
const DRIVING_STYLES = [
  {
    id:"aggressive", name:"Aggressive", icon:"ðŸ”¥", color:"#FF4444",
    desc:"Leaves nothing on the table â€” brilliant in wheel-to-wheel battles, hard on tyres and equipment.",
    effects:"Overtaking +6 · Pace +2 · Consistency âˆ’4 · Defence âˆ’4 · DNF risk +12%",
    mods:{pace:2,consistency:-4,overtaking:6,defense:-4,wet:-1,experience:0,dnfRisk:0.12,qualBonus:1,racePace:1},
  },
  {
    id:"smooth", name:"Smooth", icon:"ðŸŽ¯", color:"#44CC88",
    desc:"Never a wasted movement. Extracts the maximum from every set of tyres across a full race distance.",
    effects:"Consistency +6 · Wet +4 · Pace âˆ’2 · DNF risk âˆ’15%",
    mods:{pace:-2,consistency:6,overtaking:-2,defense:2,wet:4,experience:0,dnfRisk:-0.15,qualBonus:-1,racePace:2},
  },
  {
    id:"qualifier", name:"Qualifier", icon:"âš¡", color:"#FFC906",
    desc:"Electrifying over a single flying lap. Asks serious questions of the tyres in a race.",
    effects:"Quali pace +5 · Race consistency âˆ’4 · Experience effect âˆ’2",
    mods:{pace:0,consistency:-4,overtaking:1,defense:0,wet:-1,experience:-2,dnfRisk:0.04,qualBonus:5,racePace:-3},
  },
  {
    id:"defender", name:"Defender", icon:"ðŸ›¡ï¸", color:"#4488FF",
    desc:"Makes every overtake feel like climbing a wall. Clinical at managing gaps and holding positions.",
    effects:"Defence +8 · Consistency +3 · Overtaking âˆ’6 · Pace âˆ’2",
    mods:{pace:-2,consistency:3,overtaking:-6,defense:8,wet:1,experience:2,dnfRisk:-0.08,qualBonus:-2,racePace:0},
  },
  {
    id:"charger", name:"Charger", icon:"ðŸš€", color:"#FF8844",
    desc:"Comes alive in traffic. Finds gaps others don't see and thrives starting from the back.",
    effects:"Overtaking +8 · Pace +3 (from low grid) · Consistency âˆ’3 · Defence âˆ’3",
    mods:{pace:1,consistency:-3,overtaking:8,defense:-3,wet:1,experience:0,dnfRisk:0.06,qualBonus:-2,racePace:2},
  },
  {
    id:"strategist", name:"Strategist", icon:"â™Ÿï¸", color:"#BB66FF",
    desc:"Reads the race like a data feed. Timing is everything â€” under-cuts, safety cars, tyre windows.",
    effects:"Experience +5 · Consistency +4 · Undercut bonus · Pace âˆ’1",
    mods:{pace:-1,consistency:4,overtaking:0,defense:2,wet:2,experience:5,dnfRisk:-0.1,qualBonus:-1,racePace:1},
  },
  {
    id:"technical", name:"Technical", icon:"ðŸ”¬", color:"#00D2BE",
    desc:"At home in the corners. Precision over raw pace â€” thrives at high-downforce and technical circuits.",
    effects:"Wet +6 · Consistency +3 · Tech circuit +4 · High-speed âˆ’2",
    mods:{pace:-1,consistency:3,overtaking:0,defense:1,wet:6,experience:2,dnfRisk:-0.05,qualBonus:0,racePace:1},
  },
  {
    id:"ironman", name:"Ironman", icon:"âš™ï¸", color:"#B6BABD",
    desc:"Still circulating on lap 70 when others have retired. The metronome. Points finisher extraordinaire.",
    effects:"Consistency +7 · DNF risk âˆ’30% · Pace âˆ’3 · Overtaking âˆ’3",
    mods:{pace:-3,consistency:7,overtaking:-3,defense:3,wet:1,experience:3,dnfRisk:-0.30,qualBonus:-2,racePace:0},
  },
];

function getStyleMods(d) {
  const style = DRIVING_STYLES.find(s=>s.id===d.style);
  return style ? style.mods : {pace:0,consistency:0,overtaking:0,defense:0,wet:0,experience:0,dnfRisk:0,qualBonus:0,racePace:0};
}

// ===================== SECTOR TIMES =====================
// Every circuit is split into 3 sectors, each carrying a "corner" weight and a
// "speed" weight (0-1) describing how much cornering ability vs. top speed
// matters there, plus its share (frac) of the total lap time. Splits are
// authored per-circuit from each track's real layout character; frac values
// sum to ~1 across a track's 3 sectors.
const TRACK_SECTOR_PROFILES = {
  australia:  [{corner:0.50,speed:0.60,frac:0.35},{corner:0.70,speed:0.35,frac:0.33},{corner:0.45,speed:0.65,frac:0.32}],
  china:      [{corner:0.60,speed:0.50,frac:0.34},{corner:0.65,speed:0.45,frac:0.33},{corner:0.40,speed:0.80,frac:0.33}],
  japan:      [{corner:0.85,speed:0.55,frac:0.35},{corner:0.80,speed:0.30,frac:0.33},{corner:0.50,speed:0.75,frac:0.32}],
  bahrain:    [{corner:0.40,speed:0.75,frac:0.35},{corner:0.70,speed:0.40,frac:0.33},{corner:0.75,speed:0.35,frac:0.32}],
  saudi:      [{corner:0.35,speed:0.85,frac:0.34},{corner:0.40,speed:0.85,frac:0.33},{corner:0.60,speed:0.60,frac:0.33}],
  miami:      [{corner:0.75,speed:0.35,frac:0.34},{corner:0.50,speed:0.60,frac:0.33},{corner:0.75,speed:0.35,frac:0.33}],
  spain:      [{corner:0.45,speed:0.70,frac:0.34},{corner:0.65,speed:0.45,frac:0.33},{corner:0.80,speed:0.30,frac:0.33}],
  monaco:     [{corner:0.90,speed:0.20,frac:0.34},{corner:0.60,speed:0.55,frac:0.33},{corner:0.90,speed:0.25,frac:0.33}],
  canada:     [{corner:0.50,speed:0.65,frac:0.35},{corner:0.55,speed:0.55,frac:0.32},{corner:0.55,speed:0.70,frac:0.33}],
  madrid:     [{corner:0.60,speed:0.55,frac:0.34},{corner:0.70,speed:0.40,frac:0.33},{corner:0.65,speed:0.50,frac:0.33}],
  austria:    [{corner:0.40,speed:0.75,frac:0.35},{corner:0.55,speed:0.60,frac:0.32},{corner:0.40,speed:0.80,frac:0.33}],
  britain:    [{corner:0.55,speed:0.80,frac:0.35},{corner:0.65,speed:0.45,frac:0.32},{corner:0.55,speed:0.65,frac:0.33}],
  hungary:    [{corner:0.85,speed:0.30,frac:0.34},{corner:0.85,speed:0.25,frac:0.33},{corner:0.80,speed:0.30,frac:0.33}],
  belgium:    [{corner:0.40,speed:0.90,frac:0.36},{corner:0.80,speed:0.40,frac:0.32},{corner:0.55,speed:0.75,frac:0.32}],
  netherlands:[{corner:0.75,speed:0.45,frac:0.34},{corner:0.70,speed:0.45,frac:0.33},{corner:0.80,speed:0.40,frac:0.33}],
  italy:      [{corner:0.35,speed:0.85,frac:0.35},{corner:0.50,speed:0.75,frac:0.32},{corner:0.40,speed:0.85,frac:0.33}],
  azerbaijan: [{corner:0.80,speed:0.30,frac:0.35},{corner:0.25,speed:0.95,frac:0.32},{corner:0.55,speed:0.60,frac:0.33}],
  singapore:  [{corner:0.85,speed:0.30,frac:0.34},{corner:0.85,speed:0.30,frac:0.33},{corner:0.80,speed:0.35,frac:0.33}],
  usa:        [{corner:0.75,speed:0.55,frac:0.35},{corner:0.55,speed:0.55,frac:0.32},{corner:0.45,speed:0.75,frac:0.33}],
  mexico:     [{corner:0.35,speed:0.85,frac:0.35},{corner:0.85,speed:0.30,frac:0.33},{corner:0.60,speed:0.55,frac:0.32}],
  brazil:     [{corner:0.50,speed:0.75,frac:0.35},{corner:0.65,speed:0.50,frac:0.32},{corner:0.45,speed:0.70,frac:0.33}],
  lasvegas:   [{corner:0.30,speed:0.90,frac:0.34},{corner:0.35,speed:0.90,frac:0.33},{corner:0.55,speed:0.65,frac:0.33}],
  qatar:      [{corner:0.60,speed:0.65,frac:0.34},{corner:0.65,speed:0.60,frac:0.33},{corner:0.60,speed:0.60,frac:0.33}],
  abudhabi:   [{corner:0.55,speed:0.55,frac:0.35},{corner:0.75,speed:0.35,frac:0.32},{corner:0.45,speed:0.70,frac:0.33}],
};
// Fallback profile by track.type for any circuit missing a hand-authored layout.
const DEFAULT_SECTOR_PROFILES = {
  "high-speed":     [{corner:0.40,speed:0.75,frac:0.34},{corner:0.55,speed:0.60,frac:0.33},{corner:0.45,speed:0.75,frac:0.33}],
  "technical":      [{corner:0.80,speed:0.30,frac:0.34},{corner:0.80,speed:0.25,frac:0.33},{corner:0.75,speed:0.30,frac:0.33}],
  "street":         [{corner:0.75,speed:0.35,frac:0.34},{corner:0.70,speed:0.40,frac:0.33},{corner:0.75,speed:0.30,frac:0.33}],
  "low-downforce":  [{corner:0.35,speed:0.80,frac:0.34},{corner:0.45,speed:0.75,frac:0.33},{corner:0.35,speed:0.85,frac:0.33}],
  "high-downforce": [{corner:0.75,speed:0.35,frac:0.34},{corner:0.75,speed:0.35,frac:0.33},{corner:0.70,speed:0.40,frac:0.33}],
  mixed:            [{corner:0.60,speed:0.55,frac:0.34},{corner:0.60,speed:0.50,frac:0.33},{corner:0.55,speed:0.55,frac:0.33}],
};
function getTrackSectors(track) {
  const p = TRACK_SECTOR_PROFILES[track.id] || DEFAULT_SECTOR_PROFILES[track.type] || DEFAULT_SECTOR_PROFILES.mixed;
  return p.map((s,i)=>({...s, name:"Sector "+(i+1)}));
}
// Standard broadcast sector identity colours (S1 blue, S2 green, S3 red) â€”
// overridden by purple whenever that sector is the fastest across the field.
const SECTOR_COLORS = ["#4488FF","#44CC88","#E8002D"];

// Reference lap time (seconds) used as the baseline to split into sectors.
function refLapSeconds(track) {
  return QUAL_REFS[track.id] || (track.lapLen||5)*18.5;
}
// A race's fastest lap runs a touch slower than a qualifying pole lap (fuel load, tyre wear).
function estimateRaceLapSeconds(track) {
  return refLapSeconds(track)*1.015;
}

// A driver+car's raw affinity for a given sector â€” cornering ability and
// consistency matter more in corner-heavy sectors, top speed and pace matter
// more in power sectors, and driving style adds circuit-flavoured bonuses.
function sectorEdgeRaw(d, team, sector) {
  const sm = getStyleMods(d);
  const ts = getTeamStats(team);
  const ec = d.consistency + sm.consistency;
  const ep = d.pace + sm.pace;
  let edge = sector.corner*ts.cornerBonus + sector.speed*ts.straightBonus
           + sector.corner*ec*0.25 + sector.speed*ep*0.25;
  if (d.style==="technical") edge += sector.corner*3;
  if (d.style==="aggressive"||d.style==="charger") edge += sector.speed*2.5;
  if (d.style==="smooth") edge += sector.corner*1.5;
  return edge;
}

// Splits a driver's already-simulated lap time into 3 sector times that sum
// exactly back to lapSeconds â€” car/driver sector strength only redistributes
// time between sectors relative to the rest of the field, it never changes
// the total (so finishing order and points are untouched by this feature).
function computeSectorTimes(entry, fieldEntries, track, lapSeconds) {
  const sectors = getTrackSectors(track);
  const raw = sectors.map(s=>sectorEdgeRaw(entry.driver, entry.team, s));
  const fieldAvg = sectors.map((s,i)=>{
    const vals = fieldEntries.map(e=>sectorEdgeRaw(e.driver, e.team, s));
    return vals.reduce((a,b)=>a+b,0)/vals.length;
  });
  const K = 0.0065; // stat-point edge â†’ seconds
  let deltas = raw.map((r,i)=>(fieldAvg[i]-r)*K); // positive = slower than field average here
  const mean = deltas.reduce((a,b)=>a+b,0)/deltas.length;
  deltas = deltas.map(x=>x-mean); // conserve total lap time across the 3 sectors
  return sectors.map((s,i)=>s.frac*lapSeconds + deltas[i]);
}

// Attaches .sectors (array of 3 times) and .sectorPurple (best-in-session flags)
// to every entry in a session's results, given each entry's .score and the
// session's reference lap time in seconds.
function annotateSectorTimes(entries, track, refSeconds) {
  if (!entries?.length) return entries;
  const leaderScore = entries[0].score;
  const out = entries.map((e,i)=>{
    const gap = i===0 ? 0 : (leaderScore-e.score)*0.011;
    const lapSeconds = refSeconds+gap;
    return {...e, lapSeconds, sectors:computeSectorTimes(e, entries, track, lapSeconds)};
  });
  const bestSectors = [0,1,2].map(si=>Math.min(...out.map(e=>e.sectors[si])));
  out.forEach(e=>{ e.sectorPurple = [0,1,2].map(si=>Math.abs(e.sectors[si]-bestSectors[si])<0.0005); });
  return out;
}

const SECTOR_PUSH_MSGS = [
  "{d} sets the fastest {sec} of the race so far â€” {team} clearly happy with the balance right now.",
  "{d} goes purple through {sec} â€” nothing wasted, every apex clipped this lap.",
  "{d} is finding real pace in {sec} â€” the pit wall will have seen that one.",
  "{d} attacking hard through {sec} â€” the standout sector time on the board right now.",
  "{d} on it through {sec} â€” {team} looking planted exactly where it counts.",
];
const SECTOR_STRUGGLE_MSGS = [
  "{d} shipping time in {sec} â€” {team} will be looking hard at the data.",
  "{d} well off the pace through {sec} this lap â€” tyres talking back.",
  "{d} losing real time in {sec} â€” the sector screens don't lie.",
  "{d} conservative through {sec} right now â€” managing rather than attacking.",
  "{d} struggling for grip in {sec} â€” a lap to forget through there.",
];
const _fmtSectorMsg=(s,e,secName)=>s.replace(/{d}/g,e.driver.name).replace(/{sec}/g,secName).replace(/{team}/g,e.team.name);

// Periodic "sector spotlight" events threaded through a race. Uses each
// still-running driver's real cornering/top-speed/consistency/pace edge for
// every sector (plus lap-to-lap noise, so it's not the same name every time)
// to call out who is genuinely pushing and who is losing time, sector by
// sector, as the race unfolds â€” not just at the end via fastest lap.
function genRaceSectorEvents(entries, track, TL) {
  const events = [];
  const sectors = getTrackSectors(track);
  const checkpoints = [0.16,0.34,0.52,0.70,0.88].map(f=>Lf(TL,f));
  checkpoints.forEach(lap=>{
    const active = entries.filter(e=>!e.dnf||(e.dnfLap&&e.dnfLap>lap));
    if (active.length<6) return;
    const withEdges = active.map(e=>({
      e, edges: sectors.map(s=>sectorEdgeRaw(e.driver,e.team,s)+(Math.random()-0.5)*6),
    }));
    const avgEdges = sectors.map((s,si)=>{
      const vals=withEdges.map(x=>x.edges[si]);
      return vals.reduce((a,b)=>a+b,0)/vals.length;
    });
    let best=null, worst=null;
    withEdges.forEach(x=>{
      sectors.forEach((s,si)=>{
        const rel=x.edges[si]-avgEdges[si];
        if(!best||rel>best.rel) best={entry:x.e, si, rel};
        if(!worst||rel<worst.rel) worst={entry:x.e, si, rel};
      });
    });
    if(best) events.push({lap,type:"sector",icon:"ðŸŸ£",text:_fmtSectorMsg(pick(SECTOR_PUSH_MSGS),best.entry,sectors[best.si].name)});
    if(worst&&worst.entry.driver.id!==best?.entry.driver.id&&Math.random()<0.6) events.push({lap,type:"sector",icon:"ðŸ”»",text:_fmtSectorMsg(pick(SECTOR_STRUGGLE_MSGS),worst.entry,sectors[worst.si].name)});
  });
  return events;
}

// â•‘  calcBase()      â€” Deterministic base score from driver+team+track.     â•‘
// â•‘  calcQualBase()  â€” calcBase + qualifying style bonus.                   â•‘
// â•‘                    traffic, rivalries, mechanical issues, strategy).     â•‘
// â•‘  runSprint()     â€” Abbreviated race (~100km). Sprint points for top 8.  â•‘
// â•‘                    DNFs, weather, fastest lap, position battles.        â•‘
/**
 * Calculates a driver's base performance score for a given track.
 * Incorporates: car pace, driver stats, driving style mods, circuit type,
 * altitude, night conditions, abrasion, DRS zones, good/bad tracks, mental.
 * @param {object} d - Driver object
 * @param {object} team - Team object
 * @param {object} track - Track object
 * @returns {number} Base performance score
 */
function calcBase(d, team, track) {
  const sm = getStyleMods(d);
  const ep = d.pace       + sm.pace;
  const ec = d.consistency+ sm.consistency;
  const ew = d.wet        + sm.wet;
  const eo = d.overtaking + sm.overtaking;
  const edf= d.defense    + sm.defense;
  const ex = d.experience + sm.experience;
  // derive team performance from equipped parts
  const ts = getTeamStats(team);
  let s = ts.carPace*0.55 + ep*0.45;
  // Circuit type bonus (uses effective stats)
  if (track.type==="high-speed"||track.type==="low-downforce") s+=ep*0.06;
  else if (track.type==="technical") {
    s+=ec*0.06;
    if(d.style==="technical") s+=4; // technical specialist bonus
  }
  else if (track.type==="street") {
    s+=ex*0.03+edf*0.02;
    if(d.style==="defender") s+=2; // street defender bonus
  }
  // Downforce matching
  const dfDiff=Math.abs((track.downforce||6)-6);
  s+=ts.carPace*0.01*dfDiff*(track.downforce>6?0.5:-0.3);
  // parts circuit bonus
  if(ts.aeroCircuitBonus&&track.type&&ts.aeroCircuitBonus[track.type]) s+=ts.aeroCircuitBonus[track.type]*0.5;
  // High altitude
  if((track.alt||0)>500) s-=((track.alt-500)/2000)*((100-ex)*0.04);
  // Night races
  if(track.night) s+=ex*0.025;
  // Street circuits
  if(track.street) s+=ex*0.02+edf*0.015;
  // High abrasion (smooth style helps here)
  if((track.abrasive||3)>5) s-=((track.abrasive-5)*0.3)*((100-ec)/40);
  // DRS zones
  if((track.drs||2)>=3) s+=eo*0.015;
  // Good/bad track bonuses
  if((d.goodTracks||[]).includes(track.id)) s+=5;
  if((d.badTracks||[]).includes(track.id)) s-=5;
  // Mental
  s+=((d.mental||7)-5)*0.45;
  return s;
}

function calcQualBase(d, team, track) {
  const sm = getStyleMods(d);
  return calcBase(d,team,track) + (sm.qualBonus||0);
}

function genQEvents(session, entries, track, elimLine) {
  const evts = [];
  const sorted = [...entries].sort((a,b)=>b.score-a.score);
  const fast = sorted[0];
  const second = sorted[1];
  const SECTORS = ["Turn "+Math.ceil((track.corners||16)/3),"the hairpin","the first chicane","the second sector","the Eau Rouge complex","the fast sweepers","the penultimate corner","the final chicane"];
  const TRACK_CTX = track.street?"the unforgiving barriers":track.type==="high-speed"?"the high-speed sweepers":track.type==="technical"?"the slow-speed technical section":"the circuit";
  const bubbleZone = elimLine ? sorted.filter((_,i)=>i>=elimLine-2&&i<=elimLine+1) : [];
  const surprise = sorted.find((_,i)=>i<(elimLine||3)&&sorted.indexOf(_)>(elimLine||5));
  const rivalry = sorted.length>=2?getRivalry(sorted[0].driver,sorted[1].driver):null;
  const yf = Math.random()<(track.street?0.5:track.wr>40?0.45:0.32);
  const yfDriver = yf?_pick(sorted.slice(3,16)):null;
  const mechanical = Math.random()<0.22;
  const mechDriver = mechanical?_pick(sorted.slice(2,18)):null;
  const twoDriverBattle = Math.random()<0.55&&sorted.length>4;
  const battlePair = twoDriverBattle?[_pick(sorted.slice(0,5)),_pick(sorted.slice(1,8))]:null;

  // Yellow / Red flags
  if(yfDriver) {
    const corner=_pick(SECTORS);
    const cause=_pick(["clips the barrier with the front wing","locks up and goes wide over the kerbs","moments of snap oversteer into the wall","loses the rear exiting the corner and spins","a fraction too early on the power â€” the car snaps sideways"]);
    const consequence=_pick([
      `Multiple laps deleted â€” ${Math.ceil(Math.random()*4)} drivers in the pit lane caught with timing issues.`,
      `${_pick(sorted.slice(6,16)).driver.name} had a stunning lap going â€” the yellow flag extinguished it completely.`,
      `Crews scramble on the pitwall â€” everyone recalculating their final run timing.`,
      `Teams with drivers on hot laps furious on the radio. The timing could not have been worse.`,
    ]);
    evts.push({type:"yellow",icon:"ðŸŸ¡",driver:yfDriver.driver.name,
      text:`âš ï¸ YELLOW FLAG â€” ${yfDriver.driver.name} (${yfDriver.team.name}) ${cause} at ${corner}. ${consequence}`});
    if(track.street&&Math.random()<0.3) {
      evts.push({type:"yellow",icon:"ðŸ”´",text:`RED FLAG! The barriers need repairs after that incident. ${_pick(["Six minutes","Eight minutes","Five minutes"])} lost â€” the session clock will be extended. Teams scramble tyre allocations.`});
    }
  }

  // Mechanical / reliability
  if(mechDriver) {
    const issue=_pick(["hydraulics pressure warning","gearbox issue","brake-by-wire failure","water temperature spike","DRS mechanism stuck","front wing damage from a kerb strike","MGU-K deployment problem"]);
    const consequence=_pick([
      `${mechDriver.driver.name} pits for investigation. Engineers stare at laptops. The session is most likely over for them.`,
      `The ${mechDriver.team.name} garage erupts in activity â€” this is a critical issue at the worst possible time.`,
      `${mechDriver.driver.name} manages to return to the pit lane but the damage is already done. Time lost, rhythm broken.`,
      `Mechanics work under frantic conditions â€” if they fix it in time, ${mechDriver.driver.name} gets one lap. Just one.`,
    ]);
    evts.push({type:"mechanical",icon:"ðŸ”§",driver:mechDriver.driver.name,
      text:`ðŸ”§ ${mechDriver.driver.name} (${mechDriver.team.name}) reports a ${issue} over the radio. ${consequence}`});
  }

  // Rivalry / team-mate battle
  if(rivalry&&session==="Q3") {
    evts.push({type:"rivalry",icon:"âš”ï¸",
      text:`The paddock is watching ${rivalry.desc} play out in real time. Both drivers delivered near-identical sector times on their first runs â€” ${_pick(["the gap is tenths","thousandths separate them","the data shows almost zero difference in technique through the medium-speed corners","this could come down to tyre temperature on the final flying lap"])}.`});
  }
  if(battlePair&&battlePair[0]&&battlePair[1]&&battlePair[0].driver.id!==battlePair[1].driver.id) {
    const rv=getRivalry(battlePair[0].driver,battlePair[1].driver);
    if(rv&&Math.random()<0.6) {
      evts.push({type:"rivalry",icon:"âš”ï¸",
        text:`${rv.desc.charAt(0).toUpperCase()+rv.desc.slice(1)} is the subplot nobody can ignore. ${battlePair[0].driver.name} went ${_pick(["two","three","four","five"])} thousandths quicker through the final sector â€” ${battlePair[1].driver.name} will have seen that number and responded on the next run.`});
    }
  }

  // Session-specific events
  if(session==="Q1") {
    // Traffic chaos
    if(Math.random()<0.45) {
      const victim=_pick(sorted.slice(8,18));
      const blocker=_pick(sorted.filter(e=>e.driver.id!==victim.driver.id));
      evts.push({type:"traffic",icon:"ðŸš¦",driver:victim.driver.name,
        text:`Traffic incident: ${victim.driver.name} finds ${blocker.driver.name} on a slow out-lap right through ${_pick(SECTORS)}. The lap is ruined â€” ${_pick(["the timing shows they lost nearly four tenths","the radio exchange is not suitable for broadcast","${victim.driver.name} slams a fist on the steering wheel","a lap that could have been safe is now a question mark"])}.`});
    }
    // Track evolution story
    if(Math.random()<0.65) {
      evts.push({type:"info",icon:"ðŸ“ˆ",
        text:`Track evolution is the story of ${session} â€” lap times are ${_pick(["0."+Math.floor(Math.random()*5+2)+"s","almost half a second","nearly four tenths"])} faster now than in the opening minutes as rubber builds on the racing line. Teams that ran last have a significant advantage, and the order will look very different by the end.`});
    }
    // Impede incident
    if(track.street&&Math.random()<0.5) {
      const d1=_pick(sorted.slice(0,8)), d2=_pick(sorted.slice(8,16));
      evts.push({type:"incident",icon:"ðŸš§",
        text:`INCIDENT reported: ${d1.driver.name} and ${d2.driver.name} arrive at the same part of ${track.circuit} at the same time â€” both on flying laps. Stewards are investigating. Could result in a grid penalty before the race even begins.`});
    }
    // Lap time surprise
    if(Math.random()<0.4) {
      const darkHorse=_pick(sorted.slice(Math.floor(sorted.length*0.35),Math.floor(sorted.length*0.6)));
      evts.push({type:"surprise",icon:"­",driver:darkHorse.driver.name,team:darkHorse.team.name,
        text:`${darkHorse.driver.name} has been quietly rapid all session â€” ${darkHorse.team.name} running a different front wing spec this weekend has been the subject of paddock whispers. Whatever they've done, ${_pick(["it's working","the lap time suggests it is","it has closed the gap to the front significantly"])}.`});
    }
  }

  if(session==="Q2") {
    // Tyre strategy narrative
    if(Math.random()<0.55) {
      const gambler=_pick(sorted.slice(6,14));
      const compound=_pick(["mediums","hards","used softs"]);
      const stakes=_pick([
        "The team have committed. There is no fallback.",
        "It only needs to be within two tenths of the P10 time. Clinical execution required.",
        `If this works, ${gambler.driver.name} starts the race with free tyre choice. If it doesn't, ${gambler.team.name} have handed a gift to their rivals.`,
        "The engineering team believe the data supports this. The rest of the paddock isn't so sure.",
      ]);
      evts.push({type:"strategy",icon:"â™Ÿï¸",driver:gambler.driver.name,team:gambler.team.name,
        text:`STRATEGY CALL: ${gambler.team.name} send ${gambler.driver.name} out on ${compound} â€” preserving fresh rubber for the race start. ${stakes}`});
    }
    // Elimination knife-edge
    if(bubbleZone.length>=2) {
      const [a,b,c]=bubbleZone;
      const pA=sorted.indexOf(a)+1;
      const pB=sorted.indexOf(b)+1;
      const gap=((a.score-b.score)*0.011).toFixed(3);
      evts.push({type:"battle",icon:"±ï¸",
        text:`THE CUT LINE: ${a.driver.name} (P${pA}) and ${b.driver.name} (P${pB}) â€” ${gap}s between them and the difference between Q3 and the garage. ${_pick([
          `Both teams have sent their drivers out for final runs. The tension in the pit wall is unbearable.`,
          `${c?c.driver.name+" is breathing down their necks from P"+(sorted.indexOf(c)+1)+" â€” three drivers, two spots.":" This is the last chance."}`,
          `Radio traffic is frantic. Engineers shouting sector times. Drivers giving everything.`,
          `This is exactly the kind of story that defines a season â€” points, momentum, confidence, all hanging on a single sector.`,
        ])}`});
    }
    // Team-mate tension
    if(Math.random()<0.35) {
      const team=_pick(sorted.map(e=>e.team).filter((t,i,a)=>a.findIndex(x=>x.id===t.id)===i));
      const teammates=sorted.filter(e=>e.team.id===team.id).slice(0,2);
      if(teammates.length===2) {
        const [t1,t2]=teammates;
        evts.push({type:"rivalry",icon:"ðŸ¤",
          text:`Inside the ${team.name} garage, ${t1.driver.name} has gone ${_pick(["two","three","four"])} tenths clear of ${t2.driver.name}. Team radio to the slower car: ${_pick([
            '"You need to find more in sector two."',
            '"We need that lap. Car is capable of it."',
            '"Box after this lap â€” different wing setting."',
            '"We\'re adjusting the balance â€” give us one more lap."',
          ])} The tension is real.`});
      }
    }
  }

  if(session==="Q3") {
    // Banker lap strategy
    if(fast) {
      const risk=Math.random()<0.5;
      evts.push({type:"banker",icon:"ðŸ’œ",driver:fast.driver.name,
        text:`${fast.driver.name} sets their first run banker time: ${_pick(["clinical","composed","beautifully executed"])} lap that puts them ${_pick(["clearly","marginally","comfortably"])} at the top. Now the question: ${risk?"come back out on a second set of softs and try to improve â€” risking a yellow flag deleting the time":"bank what they have and watch the rivals struggle to beat it"}?`});
    }
    // Multiple improvement attempts
    if(second&&Math.random()<0.65) {
      evts.push({type:"final",icon:"ðŸ",driver:second.driver.name,
        text:`${second.driver.name}'s final run: purple in sector one, ${_pick(["green in sector two â€” this is a lap!","yellow in the final chicane â€” they've lost it","matching ${fast.driver.name} through the middle","marginal gains everywhere but nothing decisive"])}. The team on the pitwall are leaning forward, headphones on, every hundredth counting.`});
    }
    // Impede on final lap
    if(Math.random()<0.4) {
      const victim=_pick(sorted.slice(1,6));
      const blocker=_pick(sorted.filter(e=>e.driver.id!==victim.driver.id).slice(0,9));
      evts.push({type:"incident",icon:"âš ï¸",driver:victim.driver.name,
        text:`${victim.driver.name} BLOCKED â€” ${blocker.driver.name} on an out-lap right through ${_pick(SECTORS)} on the final flying laps. ${_pick([
          "Stewards have noted the incident.",
          "Radio message: 'That cost me at LEAST two tenths.' The damage is done.",
          "Both teams summoned to the stewards post-session.",
          "The gap to pole is now a tenth bigger than it needed to be.",
        ])}`});
    }
    // Lap time improvement
    if(Math.random()<0.5) {
      const improver=_pick(sorted.slice(2,7));
      evts.push({type:"improvement",icon:"ðŸ“‰",driver:improver.driver.name,
        text:`${improver.driver.name} IMPROVES! ${_pick([
          "Purple in all three sectors â€” this is a special lap!",
          "Gains two tenths in sector three alone â€” the final corner the key difference.",
          "Smoothest lap of the session, every corner linked beautifully.",
          "Sets a personal best through the high-speed section â€” the car looks planted.",
        ])} The timing screens flash. The order changes.`});
    }
    // Rival data breach moment
    if(rivalry&&Math.random()<0.5) {
      evts.push({type:"rivalry",icon:"ðŸ“¡",
        text:`Inside the garages of ${sorted[0].team.name} and ${sorted[1].team.name} â€” both teams watching the same timing data, adapting in real time. The engineers know every sector time, every micro-sector. ${_pick([
          "This is modern F1 at its most precise â€” and its most psychological.",
          "The margins are so small that setup philosophy, not raw pace, separates them.",
          "Every tenth gained in the data warehouse the night before is visible here.",
          "The performance gap between these two teams is now measured in hundredths.",
        ])}`});
    }
  }

  // Night-race atmosphere
  if(track.night&&Math.random()<0.6) {
    evts.push({type:"info",icon:"ðŸŒ™",
      text:`Under the floodlights at ${track.circuit}, grip levels behave differently â€” the asphalt has cooled significantly since FP2, changing tyre compound performance windows. ${_pick([
        "Several drivers reporting the car feels 'planted' in sectors they found difficult in daylight.",
        "The thermal cameras are working overtime â€” rear tyre temperatures are the critical variable.",
        "Teams running more front wing to compensate for the lower-grip conditions at night.",
        "The shadows at the apexes remain a psychological challenge â€” you can't always see where you're turning in.",
      ])}`});
  }

  return evts;
}

function runQ1Q2Q3(drivers, teams, track) {
  // Per-session form: each driver gets a session-specific random offset that persists
  // throughout that session (simulates car balance, traffic luck, tyre window hit).
  // Crucially this is re-rolled per session, so Q1/Q2/Q3 positions are independently varied.
  const makeSessionForm = (spread) => {
    const m = {};
    drivers.forEach(d => { m[d.id] = (Math.random()-0.5)*2*spread; });
    return m;
  };

  const sessionScore = (d, team, sessionNoise, tyreGain=0, lapSpread=3, sessionForm={}) => {
    const base = calcQualBase(d, team, track);
    const form = sessionForm[d.id] || 0;            // per-session driver form (consistent within session)
    const tyre = tyreGain * (0.7 + Math.random()*0.6); // fresh-tyre delta, randomised
    const lap  = (Math.random()-0.5)*2*lapSpread;   // single-lap execution variance
    return base + form + tyre + lap;
  };

  // Q1: All 20 drivers. High chaos â€” different tyre strategies, banker laps, traffic.
  const q1Form = makeSessionForm(6);
  const q1 = drivers.map(d=>{
    const team=teams.find(t=>t.id===d.teamId)||teams[teams.length-1];
    const s=sessionScore(d, team, 5, 0, 3.5, q1Form);
    return {driver:d, team, score:s, q1Score:s};
  }).sort((a,b)=>b.score-a.score).map((e,i)=>({...e, q1Pos:i+1, elim1:i>=15}));
  const q1Events = genQEvents("Q1", q1, track, 15);

  // Q2: Top 15 only. Fresh session form â€” car balance can shift significantly.
  const q2Form = makeSessionForm(5);
  const q2base = q1.filter(e=>!e.elim1).map(e=>{
    const s=sessionScore(e.driver, e.team, 4, 1.2, 3, q2Form);
    return {...e, score:s, q2Score:s};
  }).sort((a,b)=>b.score-a.score).map((e,i)=>({...e, q2Pos:i+1, elim2:i>=10}));
  const q2Events = genQEvents("Q2", q2base, track, 10);

  // Q3: Top 10 only. Full-attack flying lap. Fresh form draw â€” pole shootout can produce surprises.
  const q3Form = makeSessionForm(4);
  const q3base = q2base.filter(e=>!e.elim2).map(e=>{
    const s=sessionScore(e.driver, e.team, 3, 2.5, 2.5, q3Form);
    return {...e, score:s, q3Score:s};
  }).sort((a,b)=>b.score-a.score).map((e,i)=>({...e, q3Pos:i+1}));
  const q3Events = genQEvents("Q3", q3base, track, null);

  const grid=[...q3base,...q2base.filter(e=>e.elim2),...q1.filter(e=>e.elim1)];
  return {q1, q2:q2base, q3:q3base, grid, q1Events, q2Events, q3Events};
}

// Free practice session: all 20 drivers, no elimination, high variance.
function runFP(sessionNum, drivers, teams, track) {
  const formSpread = sessionNum===1 ? 9 : 7;
  const lapSpread  = sessionNum===1 ? 6 : 5;
  const tyreGain   = sessionNum===1 ? 0 : 0.8;
  const sessionForm = {};
  drivers.forEach(d => { sessionForm[d.id] = (Math.random()-0.5)*2*formSpread; });
  const raw = drivers.map(d => {
    const team = teams.find(t=>t.id===d.teamId)||teams[teams.length-1];
    const base  = calcQualBase(d, team, track);
    const form  = sessionForm[d.id];
    const tyre  = tyreGain * (0.7 + Math.random()*0.6);
    const lap   = (Math.random()-0.5)*2*lapSpread;
    const fuelPenalty = sessionNum===1 ? -(Math.random()*3+1) : -(Math.random()*2+0.5);
    const score = base + form + tyre + lap + fuelPenalty;
    const laps  = Math.floor(Math.random()*8 + (sessionNum===1?12:15));
    return {driver:d, team, score, laps};
  }).sort((a,b)=>b.score-a.score);
  const best = raw[0]?.score||0;
  const positions = raw.map((e,i)=>({...e, pos:i+1, gap:i===0?null:((best-e.score)*0.011).toFixed(3)}));
  return {positions, sessionNum};
}

function buildFPCaption(fpData, track) {
  if(!fpData||!fpData.positions||!fpData.positions.length) return [];
  const {positions, sessionNum} = fpData;
  const fastest = positions[0];
  const second  = positions[1];
  const gap = second ? ((fastest.score - second.score)*0.011).toFixed(3) : "0.000";
  const label = `FP${sessionNum}`;
  const topTeam = fastest.team;
  const surprise = positions.find((e,i)=>i<5 && (e.driver.goodTracks||[]).includes(track.id));
  const streetCtx = track.street ? "the barriers demand respect â€” no flying lap is risk-free in FP" : "the engineers will be studying tyre life carefully on this surface";
  return [
    _pick([
      `${label} â€” ${track.circuit.toUpperCase()}\n\n${fastest.driver.name} sets the pace in ${label} for ${topTeam.name}. ${gap}s covers the top two â€” but read nothing into it. Fuel loads, tyre compounds and aero configurations vary wildly between teams in practice.`,
      `FREE PRACTICE ${sessionNum} · ${track.name.toUpperCase()}\n\n${fastest.driver.name} (${topTeam.name}) topped the ${label} timesheet at ${track.circuit}. Practice times are notoriously misleading â€” teams run different fuel quantities and programmes â€” but the ${topTeam.name} looked genuinely quick on every compound.`,
    ]),
    _pick([
      `${second?.driver.name||"P2"} was ${gap}s back in second, though ${streetCtx}. The top ten is tightly packed â€” a tenth or two separates several cars through the midfield.`,
      `The ${sessionNum===1?"track is still green â€” grip will improve significantly as rubber goes down over the weekend":"race simulation runs completed this afternoon give teams their first real picture of tyre degradation at race pace. Strategists will be poring over every data point tonight"}.`,
    ]),
    surprise ? `${surprise.driver.name} looked particularly at home here â€” this is a circuit that suits their driving style, and the ${label} data will encourage the ${surprise.team.name} garage going into the rest of the weekend.` :
    _pick([
      `${sessionNum===1?"Teams will now assess the data and decide tyre allocations for the rest of the weekend.":"With practice complete, attention turns to qualifying. The short-run pace was clearer in FP2 â€” expect the competitive order to resemble this more closely come Q1."}`,
      `${positions[4]?.driver.name||"The midfield"} impressed in ${label} â€” an unexpected name in the top five that will have the data analysts at the other teams raising eyebrows.`,
    ]),
  ];
}

// Sprint qualifying: SQ1/SQ2/SQ3 â€” shorter sessions, same knockout structure as Q1/Q2/Q3.
function runSprintQual(drivers, teams, track) {
  const seen=new Set();
  drivers=drivers.filter(d=>{if(seen.has(d.id)) return false;seen.add(d.id);return true;}).slice(0,22);
  const makeSessionForm = (spread) => {
    const m = {};
    drivers.forEach(d => { m[d.id] = (Math.random()-0.5)*2*spread; });
    return m;
  };
  const sessionScore = (d, team, lapSpread, tyreGain=0, sessionForm={}) => {
    const base = calcQualBase(d, team, track);
    const form = sessionForm[d.id] || 0;
    const tyre = tyreGain * (0.7 + Math.random()*0.6);
    const lap  = (Math.random()-0.5)*2*lapSpread;
    return base + form + tyre + lap;
  };
  const sq1Form = makeSessionForm(6);
  const sq1 = drivers.map(d => {
    const team = teams.find(t=>t.id===d.teamId)||teams[teams.length-1];
    const s = sessionScore(d, team, 3.5, 0, sq1Form);
    return {driver:d, team, score:s, sq1Score:s};
  }).sort((a,b)=>b.score-a.score).map((e,i)=>({...e, sq1Pos:i+1, sqElim1:i>=15}));
  const sq1Events = genQEvents("Q1", sq1, track, 15);
  const sq2Form = makeSessionForm(5);
  const sq2base = sq1.filter(e=>!e.sqElim1).map(e => {
    const s = sessionScore(e.driver, e.team, 3, 1.0, sq2Form);
    return {...e, score:s, sq2Score:s};
  }).sort((a,b)=>b.score-a.score).map((e,i)=>({...e, sq2Pos:i+1, sqElim2:i>=10}));
  const sq2Events = genQEvents("Q2", sq2base, track, 10);
  const sq3Form = makeSessionForm(4);
  const sq3base = sq2base.filter(e=>!e.sqElim2).map(e => {
    const s = sessionScore(e.driver, e.team, 2.5, 2.0, sq3Form);
    return {...e, score:s, sq3Score:s};
  }).sort((a,b)=>b.score-a.score).map((e,i)=>({...e, sq3Pos:i+1}));
  const sq3Events = genQEvents("Q3", sq3base, track, null);
  const sprintGrid = [...sq3base, ...sq2base.filter(e=>e.sqElim2), ...sq1.filter(e=>e.sqElim1)];
  return {sq1, sq2:sq2base, sq3:sq3base, sprintGrid, sq1Events, sq2Events, sq3Events};
}

function aggSprintQual(n, drivers, teams, track) {
  if(n<=1) {
    const r = runSprintQual(drivers,teams,track);
    const ref = refLapSeconds(track);
    return {...r, sq1:annotateSectorTimes(r.sq1,track,ref), sq2:annotateSectorTimes(r.sq2,track,ref), sq3:annotateSectorTimes(r.sq3,track,ref)};
  }
  const sq1Acc={}, sq2Acc={}, sq3Acc={};
  drivers.forEach(d=>{ sq1Acc[d.id]=[]; sq2Acc[d.id]=[]; sq3Acc[d.id]=[]; });
  let displayRun=null;
  for(let i=0;i<n;i++){
    const q=runSprintQual(drivers,teams,track);
    if(i===Math.floor(n/2)) displayRun=q;
    q.sq1.forEach(e=>sq1Acc[e.driver.id].push(e.score));
    q.sq2.forEach(e=>sq2Acc[e.driver.id].push(e.score));
    q.sq3.forEach(e=>sq3Acc[e.driver.id].push(e.score));
  }
  const avg=arr=>arr.length?arr.reduce((a,b)=>a+b,0)/arr.length:null;
  const driverMap=drivers.map(d=>{
    const team=teams.find(t=>t.id===d.teamId)||teams[teams.length-1];
    return {driver:d, team, sq1Score:avg(sq1Acc[d.id])||0, sq2Score:avg(sq2Acc[d.id]), sq3Score:avg(sq3Acc[d.id])};
  });
  const sq1Avg=[...driverMap].sort((a,b)=>b.sq1Score-a.sq1Score).map((e,i)=>({...e, score:e.sq1Score, sq1Pos:i+1, sqElim1:i>=15}));
  const sq2All=[...driverMap].map(e=>({...e, score:e.sq2Score!==null?e.sq2Score:e.sq1Score-3})).sort((a,b)=>b.score-a.score);
  const sq2Avg=[...sq2All.slice(0,15).map((e,i)=>({...e, sq2Pos:i+1, sqElim2:i>=10})),...sq2All.slice(15).map((e,i)=>({...e, sq2Pos:16+i, sqElim2:true}))];
  const sq3All=[...driverMap].map(e=>({...e, score:e.sq3Score!==null?e.sq3Score:(e.sq2Score!==null?e.sq2Score-2:e.sq1Score-5)})).sort((a,b)=>b.score-a.score);
  const sq3Avg=sq3All.slice(0,10).map((e,i)=>({...e, sq3Pos:i+1}));
  const sq2Elim=sq2Avg.filter(e=>e.sqElim2).sort((a,b)=>a.sq2Pos-b.sq2Pos);
  const sq1Elim=sq1Avg.filter(e=>e.sqElim1).sort((a,b)=>a.sq1Pos-b.sq1Pos);
  const sqSeen=new Set();
  const sprintGrid=[...sq3Avg,...sq2Elim,...sq1Elim].filter(e=>{if(sqSeen.has(e.driver.id)) return false;sqSeen.add(e.driver.id);return true;});
  driverMap.filter(e=>!sqSeen.has(e.driver.id)).sort((a,b)=>b.sq1Score-a.sq1Score).forEach(e=>{sprintGrid.push({...e,score:e.sq1Score});sqSeen.add(e.driver.id);});
  const avgElim1=new Set(sq1Elim.map(e=>e.driver.id));
  const avgElim2=new Set(sq2Elim.map(e=>e.driver.id));
  const sq1Display=displayRun?displayRun.sq1.map(e=>({...e, sqElim1:avgElim1.has(e.driver.id)})):sq1Avg;
  const sq2Display=displayRun?displayRun.sq2.map(e=>({...e, sqElim2:avgElim2.has(e.driver.id)})):sq2Avg;
  const sq3Display=displayRun?displayRun.sq3:sq3Avg;
  const ref=refLapSeconds(track);
  return {sq1:annotateSectorTimes(sq1Display,track,ref), sq2:annotateSectorTimes(sq2Display,track,ref), sq3:annotateSectorTimes(sq3Display,track,ref), sprintGrid:sprintGrid.map(e=>({...e,score:e.sq3Score||e.sq2Score||e.sq1Score})), runsUsed:n, sq1Events:genQEvents("Q1",sq1Display,track,15), sq2Events:genQEvents("Q2",sq2Display,track,10), sq3Events:genQEvents("Q3",sq3Display,track,null)};
}

function buildSQCaption(session, entries, track) {
  if(!entries||!entries.length) return [];
  const sorted=[...entries].sort((a,b)=>b.score-a.score);
  const fastest=sorted[0], second=sorted[1];
  const gap=second?((fastest.score-second.score)*0.011).toFixed(3):"0.000";
  const dropped = session==="SQ1"?sorted.slice(sorted.length-5):session==="SQ2"?sorted.slice(sorted.length-5):[];
  const sessionDesc = session==="SQ1"?"12-minute sprint qualifying opener":session==="SQ2"?"10-minute battle for the SQ3 places":"8-minute sprint pole shootout";
  return [
    _pick([
      `${session} â€” ${track.circuit.toUpperCase()} | SPRINT QUALIFYING\n\n${fastest.driver.name} (${fastest.team.name}) sets the pace in ${session} with ${gap}s over ${second?.driver.name||"P2"}. The ${sessionDesc} â€” shorter, sharper, less margin for error than standard qualifying.`,
      `SPRINT QUALIFYING ${session} · ${track.name.toUpperCase()}\n\n${fastest.driver.name} leads ${session} for ${fastest.team.name}. ${gap}s covers P1 and P2 â€” in sprint qualifying every tenth matters because there are no second chances.`,
    ]),
    session==="SQ3"
      ? _pick([
          `${fastest.driver.name} takes sprint pole. From the front ${fastest.driver.name} controls the sprint race â€” ${second?.driver.name||"P2"} lines up alongside and will be watching for the opening.`,
          `Sprint pole belongs to ${fastest.driver.name}. The ${fastest.team.name} driver delivered a clean lap in SQ3. ${second?.driver.name||"P2"} starts alongside â€” expect a battle to the first braking zone.`,
        ])
      : dropped.length
        ? `${session} eliminations: ${dropped.map(e=>e.driver.name).join(", ")} â€” knocked out with sprint qualifying complete for them.`
        : `All drivers progress from ${session}.`,
  ];
}

function runSprint(grid, teams, track) {
  const spSeen=new Set();
  grid=grid.filter(e=>{if(spSeen.has(e.driver.id)) return false;spSeen.add(e.driver.id);return true;}).slice(0,22);
  const spLaps=track.lapLen?Math.max(12,Math.round(100/track.lapLen)):Math.max(12,Math.floor(track.laps*0.33));
  const entries=grid.map((q,i)=>{
    const {driver:d,team}=q;
    let pace=calcBase(d,team,track)-i*0.12*(track.od/100)+(Math.random()-0.5)*7;
    const dnf=Math.random()<0.04;
    return {driver:d,team,gridPos:i+1,pace,dnf,dnfLap:dnf?Math.floor(Math.random()*spLaps)+1:null};
  });
  const fin=entries.filter(e=>!e.dnf).sort((a,b)=>b.pace-a.pace);
  const dns=entries.filter(e=>e.dnf);
  const final=[...fin,...dns];
  let cg=0;
  final.forEach((e,i)=>{
    e.finalPos=i+1;
    if(i===0){e.gap=0;return;}
    if(e.dnf){e.gap=null;return;}
    cg=parseFloat((cg+Math.random()*1.6+0.2).toFixed(3));
    e.gap=cg;
  });
  final.forEach((e,i)=>{e.points=!e.dnf&&i<8?SPRINT_PTS[i]:0;});
  return {positions:final,sprintLaps:spLaps};
}

// â”€â”€ buildQuarterStandings â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Takes the final sorted positions array and produces 4 quarter snapshots.
// quarterWeather: array of {wet,sc} per quarter so wet conditions increase
// swap chaos and widen gaps (rain causes unpredictability).
function buildQuarterStandings(finalPositions, totalLaps, quarterWeather) {
  var qw = quarterWeather || [{wet:false,sc:false},{wet:false,sc:false},{wet:false,sc:false},{wet:false,sc:false}];
  var baseSwap  = [7, 4, 2, 0];
  var gapScales = [[0.3,2.2],[0.8,4.5],[1.5,7.0],[null,null]];

  // Deduplicate by driver id and cap at 22 â€” prevents any upstream duplication showing in standings
  var seenQ={};
  var uniquePositions = finalPositions.filter(function(e){
    var id=e.driver&&e.driver.id;
    if(!id||seenQ[id]) return false;
    seenQ[id]=true;
    return true;
  }).slice(0,22);

  return [0,1,2,3].map(function(qi) {
    var TLq    = Math.floor(totalLaps * [0.25,0.50,0.75,1.0][qi]);
    var isWetQ = qw[qi] && qw[qi].wet;
    var hasSCQ = qw[qi] && qw[qi].sc;
    var hasRFQ = qw[qi] && qw[qi].rf;
    var window = baseSwap[qi] + (isWetQ ? 4 : 0) + (hasSCQ ? 2 : 0) + (hasRFQ ? 5 : 0);

    // Q4 = exact final positions â€” DNFs already sorted to the back, one entry per driver
    if(qi === 3) {
      return uniquePositions.map(function(e,i){
        return {driver:e.driver,team:e.team,pos:i+1,gap:e.dnf?null:e.gap,dnf:!!e.dnf,dnfLap:e.dnfLap||null,dnfReason:e.dnfReason||null,gridPos:e.gridPos,timePenalty:e.timePenalty||null,points:e.points||0,weather:qw[qi]};
      });
    }

    // Split into active (not yet DNF'd at this quarter) and already-retired
    // A driver is retired at this quarter if they have a dnf and dnfLap <= this quarter's last lap
    var preDNF=[], stillRacing=[];
    uniquePositions.forEach(function(e){
      if(e.dnf && e.dnfLap && e.dnfLap <= TLq) preDNF.push(e);
      else stillRacing.push(e);
    });

    // Shuffle only the still-racing drivers within the swap window
    var order = stillRacing.slice();
    var swapCount = window * 3;
    for(var s = 0; s < swapCount; s++) {
      var idx    = Math.floor(Math.random() * order.length);
      var offset = Math.floor(Math.random() * window * 2 + 1) - window;
      var target = Math.max(0, Math.min(order.length - 1, idx + offset));
      if(idx !== target) { var tmp=order[idx]; order[idx]=order[target]; order[target]=tmp; }
    }

    // DNF drivers sorted by dnfLap desc (retired latest first), appended at back
    preDNF.sort(function(a,b){ return (b.dnfLap||0)-(a.dnfLap||0); });
    var sorted = order.concat(preDNF);

    // Fresh gap values for still-racing drivers only
    var gs=gapScales[qi];
    var wetMult=isWetQ?1.4:1.0;
    var scMult =hasSCQ?0.6:1.0;
    var rfMult =hasRFQ?0.4:1.0;
    var qg=0;
    return sorted.map(function(e,i){
      var isDNF = preDNF.indexOf(e) !== -1;
      if(i > 0 && !isDNF){
        var step=(gs[0]+Math.random()*(gs[1]-gs[0]))*wetMult*scMult*rfMult;
        if(i<=2) step*=0.45;
        else if(i>=10) step*=1.5;
        qg=parseFloat((qg+step).toFixed(2));
      }
      return {
        driver:e.driver, team:e.team, pos:i+1,
        gap:isDNF?null:(i===0?0:qg),
        dnf:isDNF, dnfLap:isDNF?e.dnfLap:null, dnfReason:isDNF?(e.dnfReason||null):null,
        gridPos:e.gridPos, weather:qw[qi]
      };
    });
  });
}

function runRace(grid, teams, track) {
  const TL=track.laps, events=[];
  const isWet=Math.random()*100<track.wr;
  // Wet conditions make safety cars far more likely (+25pp), and can trigger VSC
  const scProb=isWet?Math.min(0.92,0.52+0.25):0.52;
  const hasSC=Math.random()<scProb;
  const scLap=hasSC?Lf(TL,0.2)+Math.floor(Math.random()*Lf(TL,0.3)):0;
  const scEnd=hasSC?scLap+Math.floor(Math.random()*4)+3:0;
  // Second safety car possible in wet races
  const hasSC2=isWet&&Math.random()<0.35;
  const sc2Lap=hasSC2?Lf(TL,0.55)+Math.floor(Math.random()*Lf(TL,0.2)):0;
  const sc2End=hasSC2?sc2Lap+Math.floor(Math.random()*3)+2:0;

  // Per-quarter weather: race can dry out over time
  // dryingLap = lap when track starts to dry (0 = stays wet all race)
  const dryingLap = isWet ? (Math.random()<0.5 ? Lf(TL,0.35)+Math.floor(Math.random()*Lf(TL,0.3)) : 0) : 0;

  // â”€â”€ Red Flag â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Higher probability on street circuits and wet conditions
  const rfBaseProb = track.type==="street" ? 0.28 : 0.14;
  const rfProb = isWet ? rfBaseProb + 0.18 : rfBaseProb;
  const hasRF = Math.random() < rfProb;
  // Red flag lap: avoid first 3 laps and last 5 laps (must leave racing time)
  const rfLap = hasRF ? Math.max(4, Lf(TL,0.12)+Math.floor(Math.random()*Lf(TL,0.65))) : 0;
  // Suspension duration in laps: 3â€“8 laps off track
  const rfDuration = hasRF ? 3+Math.floor(Math.random()*6) : 0;
  const rfResumeLap = hasRF ? Math.min(rfLap+rfDuration, TL-3) : 0;
  // Red flag cause
  const RF_CAUSES = isWet
    ? ["massive aquaplaning incident â€” car in the barriers","flooding on the racing line â€” race suspended","multi-car pile-up in the wet","driver airlifted from cockpit â€” precautionary red flag"]
    : ["enormous crash at turn 1 â€” debris everywhere","fire in the pit lane â€” race suspended","car stranded in dangerous position","medical intervention required on track â€” red flag shown"];
  const rfCause = hasRF ? pick(RF_CAUSES) : "";
  // After red flag: teams get free tyre change â€” all cars line up pit-lane order
  // This means on restart the order is set at rfLap positions (slight shuffle)
  const rfRestartMessages = [
    "STANDING START restart! Grid reformed on the pit straight.",
    "ROLLING START for the resumption â€” safety car leads the field.",
    "STANDING START from the grid! All bets are off.",
  ];

  const quarterWeather = [0.25,0.50,0.75,1.0].map(function(frac){
    var midLap = Math.floor(TL * frac);
    var wet = isWet && (dryingLap === 0 || midLap < dryingLap);
    var sc  = hasSC&&scLap<=midLap&&scEnd>=Math.floor(TL*(frac-0.25))||hasSC2&&sc2Lap<=midLap&&sc2End>=Math.floor(TL*(frac-0.25));
    var rf  = hasRF && rfLap<=midLap && rfResumeLap>=Math.floor(TL*(frac-0.25));
    return {wet:wet, sc:!!sc, rf:!!rf};
  });

  let entries=grid.map((q,i)=>{
    const {driver:d,team}=q;
    const strat=getTeamStrategy(team);
    const _ts=getTeamStats(team);
    let pace=isWet?_ts.carPace*0.35+d.pace*0.15+d.wet*0.5+(_ts.wetBonus||0)*0.3:_ts.carPace*0.5+d.pace*0.3+d.consistency*0.2;
    pace*=(strat.mods?.overallPace||1.0);
    if(track.type==="street") pace+=(d.experience+d.defense)*0.05;
    if(track.type==="high-speed") pace+=d.pace*0.06;
    if(track.type==="technical") pace+=d.consistency*0.06;
    if(track.type==="low-downforce") pace+=d.pace*0.08;
    if((d.goodTracks||[]).includes(track.id)) pace+=3;
    if((d.badTracks||[]).includes(track.id)) pace-=3;
    pace+=((d.mental||7)-5)*0.35;
    pace-=i*0.18*(track.od/100)*(hasSC?0.55:1);
    pace+=(Math.random()-0.5)*9;
    const dnfR=Math.max(0.02,(100-_ts.reliability)/100*0.28+Math.max(0,(5-(d.mental||7))*0.02)+(strat.mods?.dnfRisk||0)+(isWet?0.06:0));
    const dnf=Math.random()<dnfR;
    const dnfL=dnf?Math.max(2,Lf(TL,0.05)+Math.floor(Math.random()*Lf(TL,0.85))):null;
    const fl1=i>4&&Math.random()<0.032;
    return {driver:d,team,gridPos:i+1,pace,dnf:dnf||fl1,dnfLap:fl1?1:dnfL,fl1,compound:pick(CPDS)};
  });

  const finishers=entries.filter(e=>!e.dnf).sort((a,b)=>b.pace-a.pace);
  const dnfs=entries.filter(e=>e.dnf).sort((a,b)=>(b.dnfLap||0)-(a.dnfLap||0));
  const final=[...finishers,...dnfs];

  const pole=grid[0];
  const badS=pick(grid.slice(2,8));
  const poleStrat=getTeamStrategy(pole.team);
  const p2Strat=getTeamStrategy(grid[1]?.team||teams[0]);
  const stratContrast=poleStrat?.id!==p2Strat?.id?` ${pole.team.name} on ${poleStrat?.name||"standard"} strategy, ${grid[1]?.team?.name||"P2"} favouring ${p2Strat?.name||"different approach"} â€” a fascinating strategic duel awaits.`:"";
  events.push({lap:1,type:"start",icon:"ðŸš¦",text:`LIGHTS OUT! ${pole.driver.name} nails the launch from pole. ${badS.driver.name} loses ground immediately.${stratContrast}`});
  const fl1a=pick(grid.slice(3,11)),fl1b=pick(grid.slice(3,11).filter(e=>e!==fl1a));
  if(fl1b) events.push({lap:1,type:"incident",icon:"âš ï¸",text:`LAP 1: ${fl1a.driver.name} and ${fl1b.driver.name} touch through the first complex â€” both continue.`});
  entries.filter(e=>e.fl1).forEach(e=>events.push({lap:1,type:"incident",icon:"ðŸ’¥",text:`FIRST LAP CHAOS! ${e.driver.name} is OUT!`}));
  if(isWet){
    events.push({lap:1,type:"weather",icon:"ðŸŒ§ï¸",text:`RAIN at ${track.circuit}! Conditions treacherous â€” wets mandatory. Car control critical.`});
    // Wet-specific early incidents â€” higher chance of spins and lock-ups
    if(Math.random()<0.65){
      const spinD=pick(grid.slice(2,15));
      events.push({lap:Lf(TL,0.06),type:"incident",icon:"ðŸ’¦",text:`Lap ${Lf(TL,0.06)}: ${spinD.driver.name} SPINS on the wet tarmac! Narrowly avoids the wall.`});
    }
    if(Math.random()<0.50){
      const lockD=pick(grid.slice(3,18));
      events.push({lap:Lf(TL,0.10),type:"incident",icon:"ðŸŒŠ",text:`Lap ${Lf(TL,0.10)}: ${lockD.driver.name} aquaplanes through turn 3 â€” massive moment! Car saved.`});
    }
    if(dryingLap>0){
      events.push({lap:dryingLap,type:"weather",icon:"ðŸŒ¤ï¸",text:`Lap ${dryingLap}: Track beginning to dry. Teams agonising over the switch to intermediates â€” timing is everything.`});
      events.push({lap:dryingLap+3,type:"weather",icon:"â˜€ï¸",text:`Lap ${dryingLap+3}: Racing line drying fast. Slicks vs inters battle begins â€” wrong call here loses the race.`});
    }
  }
  if(hasSC2){
    events.push({lap:sc2Lap,type:"safetycar",icon:"ðŸš—",text:`SECOND SAFETY CAR lap ${sc2Lap}!${isWet?" Visibility near zero â€” dangerous conditions.":"Another incident brings the SC back out."} Gaps erased again.`});
    events.push({lap:sc2End,type:"safetycar",icon:"ðŸŸ¢",text:`Green flag lap ${sc2End}! SC withdraws â€” ${isWet?"soaking wet track,":""}expect fireworks at the restart.`});
  }
  [[0,4,Lf(TL,0.09),"the lead"],[4,8,Lf(TL,0.14),"the points"],[8,13,Lf(TL,0.19),"upper midfield"],[13,18,Lf(TL,0.23),"lower midfield"],[18,22,Lf(TL,0.27),"the back"]].forEach(([a,b,lap,lbl])=>{
    const grp=final.slice(a,b).filter(e=>!e.dnf);
    if(grp.length<2) return;
    const [x,y]=pickN(grp,2);
    if(x&&y) events.push({lap,type:"battle",icon:"ðŸ”¥",text:`Lap ${lap}: ${x.driver.name} and ${y.driver.name} nose-to-tail in ${lbl}.`});
  });
  // â”€â”€ Penalty & event-DNF trackers (fed by events, applied after gap calc) â”€â”€
  const timePenalties={};  // driverId -> seconds
  const eventDNFs={};      // driverId -> {lap, reason}
  const addPenalty=(driver,secs)=>{ timePenalties[driver.id]=(timePenalties[driver.id]||0)+secs; };
  const addEventDNF=(driver,lap,reason)=>{ if(!eventDNFs[driver.id]) eventDNFs[driver.id]={lap,reason}; };

  // â”€â”€ Pit stop helper: normal, slow, or disaster (wet-aware, penalty-aware) â”€â”€
  const pitEvent=(e,lap,stopNum)=>{
    const strat=getTeamStrategy(e.team);
    const wetPitCpd=isWet?pick(["Intermediates","Wets","Intermediates"]):null;
    const cpd=wetPitCpd||pick(CPDS);
    const r=Math.random();
    const disasterThresh=isWet?0.14:0.10;
    const slowThresh    =isWet?0.36:0.28;
    const gambleThresh  =isWet?0.44:0.38;
    if(r<disasterThresh){
      // Pit disaster â€” pick specific type with matching penalty
      const dtype=Math.floor(Math.random()*4);
      if(dtype===0){
        // Unsafe release into traffic â†’ 5s penalty
        addPenalty(e.driver,5);
        const wetSuffix=isWet?" Pitlane soaking wet â€” driver nearly loses it.":"";
        return {lap,type:"pitstop",icon:"ðŸš¨",text:`LAP ${lap}: ${e.driver.name} (${e.team.name}) â€” UNSAFE RELEASE into traffic!${wetSuffix} 5-SECOND TIME PENALTY ISSUED.`};
      } else if(dtype===1){
        // Wrong compound â†’ 10s stop-and-go equivalent
        addPenalty(e.driver,10);
        return {lap,type:"pitstop",icon:"ðŸš¨",text:`LAP ${lap}: ${e.driver.name} (${e.team.name}) â€” Wrong compound fitted! Back to the box â€” 10-SECOND TIME PENALTY applied.`};
      } else if(dtype===2){
        // Front wing not secured â†’ 5s penalty + slow stop
        addPenalty(e.driver,5);
        return {lap,type:"slowstop",icon:"ðŸš¨",text:`LAP ${lap}: ${e.driver.name} â€” Front wing not secured! Pits again next lap. 5-SECOND TIME PENALTY.`};
      } else {
        // Lollipop / jack error â†’ 5s penalty
        addPenalty(e.driver,5);
        const wetSuffix=isWet?" Chaos in the wet pit lane.":"";
        return {lap,type:"pitstop",icon:"ðŸš¨",text:`LAP ${lap}: ${e.driver.name} (${e.team.name}) â€” Lollipop error!${wetSuffix} Released too early â€” 5-SECOND TIME PENALTY.`};
      }
    } else if(r<slowThresh){
      const secs=(isWet?5.5+Math.random()*5:4+Math.random()*6).toFixed(1);
      const txt=pick(PIT_DISASTERS[0].texts).replace("{t}",secs);
      return {lap,type:"slowstop",icon:"âš ï¸",text:`LAP ${lap}: ${e.driver.name} pits â€” ${txt}${isWet?" Cold tyres in the wet â€” treacherous.":" "} Exits on ${cpd}.`};
    } else if(r<gambleThresh){
      const wetGamble=isWet?_pick(["SLICKS in the wet?! Enormous gamble!","Going to slicks as rain intensifies â€” bold move!","Staying on slicks â€” they're committing to the drying line."]):"";
      const d=PIT_DISASTERS[2];
      const txt=wetGamble||pick(d.texts).replace("{cpd}",cpd);
      return {lap,type:"strategy",icon:"â™Ÿï¸",text:`LAP ${lap}: ${e.driver.name} (${e.team.name}) â€” ${txt}`};
    } else {
      const stratNote=strat?_pick(strat.lapNotes||["Executing team strategy"]):"";
      const pitTime=(isWet?2.5+Math.random()*1.2:2.0+Math.random()*0.9).toFixed(1);
      const stopLabel=stopNum===1?"First stop":stopNum===2?"Second stop":"Final stop";
      const wetNote=isWet?" ðŸŒ§ï¸ "+_pick(["Intermediates the call.","Wets still on.","Going to inters.","Brave call for slicks."]):"";
      return {lap,type:"pitstop",icon:"ðŸ”„",text:`LAP ${lap}: ${e.driver.name} (${e.team.name}) pits â€” ${cpd} fitted in ${pitTime}s. ${stopLabel}.${wetNote} ${stratNote||""}`};
    }
  };

  const p1b=Lf(TL,0.25);
  pickN(finishers.slice(0,Math.min(12,finishers.length)),6).forEach((e,i)=>{
    events.push(pitEvent(e,p1b+i*2,1));
  });
  if(finishers.length>=4){
    const[u1,u2]=finishers.slice(1,5);
    if(u1&&u2) events.push({lap:p1b+4,type:"strategy",icon:"â™Ÿï¸",text:`LAP ${p1b+4}: ${u1.driver.name} attempts the undercut on ${u2.driver.name} â€” will it work?`});
  }
  [[0,1],[2,3],[5,6],[8,9],[11,12],[14,15],[17,18]].forEach(([a,b],idx)=>{
    if(!finishers[a]||!finishers[b]) return;
    const lap=Lf(TL,0.38)+idx*Math.floor(TL*0.025);
    events.push({lap,type:"battle",icon:"ðŸ”¥",text:`Lap ${lap}: ${finishers[a].driver.name} vs ${finishers[b].driver.name} â€” DRS! Side by side!`});
  });
  if(hasSC){
    events.push({lap:scLap,type:"safetycar",icon:"ðŸš—",text:`SAFETY CAR lap ${scLap}! Field bunches. Strategy chaos across the pitlane.`});
    const scF=finishers.length>3?pick(finishers.slice(3,Math.min(10,finishers.length))):null;
    if(scF) events.push(pitEvent(scF,scLap+1,2));
    events.push({lap:scEnd,type:"safetycar",icon:"ðŸŸ¢",text:`Green flag lap ${scEnd}! Safety car in â€” gaps erased, racing resumes.`});
  }
  // â”€â”€ Red Flag sequence â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if(hasRF){
    // Suspension announcement
    events.push({lap:rfLap,type:"redflag",icon:"ðŸ”´",text:`ðŸ”´ RED FLAG! LAP ${rfLap}/${TL} â€” ${rfCause}. RACE SUSPENDED.`});
    // Drivers are told to slow and return to pit lane
    events.push({lap:rfLap,type:"redflag",icon:"ðŸ”´",text:`All cars return to the pit lane. Officials assessing the situation. Race clock stopped.`});
    // Free tyre/wing changes while race is suspended
    const rfPitDrivers=pickN(finishers.slice(0,Math.min(15,finishers.length)),Math.min(8,finishers.length));
    rfPitDrivers.forEach(function(e){
      const cpd=isWet?pick(["Intermediates","Wets","Slicks"]):pick(CPDS);
      const wingNote=Math.random()<0.25?" Front wing replaced.":"";
      events.push({lap:rfLap+1,type:"pitstop",icon:"ðŸ”„",text:`RED FLAG PIT: ${e.driver.name} (${e.team.name}) fits ${cpd} â€” free stop under suspension.${wingNote}`});
    });
    // Track inspection / delay
    const delayMins=5+Math.floor(Math.random()*20);
    events.push({lap:rfLap+Math.floor(rfDuration*0.4),type:"redflag",icon:"ðŸ”´",text:`Track inspection underway. ${delayMins}-minute delay anticipated. Marshals clearing the incident.`});
    // Medical / recovery note (wet races more serious)
    if(isWet&&Math.random()<0.5){
      events.push({lap:rfLap+Math.floor(rfDuration*0.5),type:"redflag",icon:"ðŸš‘",text:`Medical car on track. Driver receiving attention. Race director in communication with both teams.`});
    }
    // Race director decision â€” resume or declare result at last lap completed
    const resumeDecision=rfResumeLap<TL-2;
    if(resumeDecision){
      events.push({lap:rfResumeLap-1,type:"redflag",icon:"ðŸŸ¢",text:`RACE DIRECTOR: Racing will resume from LAP ${rfResumeLap}. ${pick(rfRestartMessages)}`});
      // Restart overtakes
      const restartP=pick(finishers.slice(1,Math.min(6,finishers.length)));
      const restartVic=finishers[0];
      if(restartP&&restartVic&&Math.random()<0.45){
        events.push({lap:rfResumeLap,type:"battle",icon:"âš¡",text:`RESTART LAP ${rfResumeLap}: ${restartP.driver.name} OVERTAKES ${restartVic.driver.name} off the line! New LEADER!`});
      } else {
        events.push({lap:rfResumeLap,type:"start",icon:"ðŸš¦",text:`RESTART LAP ${rfResumeLap}: ${restartVic.driver.name} leads into turn 1. Frantic racing resumes â€” ${TL-rfResumeLap} laps remaining.`});
      }
      // Restart incidents common â€” some cause DNF, some cause time penalty
      if(Math.random()<0.40){
        const incD=pick(finishers.slice(3,Math.min(14,finishers.length)));
        if(incD){
          const crashR=Math.random();
          if(crashR<0.30){
            // Serious crash â†’ DNF
            addEventDNF(incD.driver,rfResumeLap,"restart collision");
            events.push({lap:rfResumeLap,type:"dnf",icon:"ðŸ’¥",text:`RESTART LAP ${rfResumeLap}: ${incD.driver.name} INTO THE BARRIER! Massive crash â€” CAR DESTROYED. DNF.`});
          } else if(crashR<0.60){
            // Contact â†’ 5s penalty
            const incD2=pick(finishers.slice(1,10).filter(x=>x!==incD));
            addPenalty(incD.driver,5);
            events.push({lap:rfResumeLap,type:"incident",icon:"âš ï¸",text:`Lap ${rfResumeLap}: ${incD.driver.name} makes contact with ${incD2?incD2.driver.name:"P2"} under braking â€” 5-SECOND TIME PENALTY for causing a collision.`});
          } else {
            // Close call â€” no penalty
            events.push({lap:rfResumeLap,type:"incident",icon:"âš ï¸",text:`Lap ${rfResumeLap}: ${incD.driver.name} locked up at the restart â€” both cars continue, stewards investigating.`});
          }
        }
      }
    } else {
      events.push({lap:rfLap+1,type:"redflag",icon:"ðŸ”´",text:`RACE DECLARED. Results taken at the end of lap ${rfLap-1}. Insufficient laps remaining to restart.`});
    }
  }
  // Only fire generic RETIREMENT events for DNFs not already covered by an event-DNF message
  entries.filter(e=>e.dnf&&!e.fl1&&e.dnfLap>1&&!eventDNFs[e.driver.id]).forEach(e=>events.push({lap:e.dnfLap,type:"dnf",icon:"ðŸ”§",text:`LAP ${e.dnfLap}: RETIREMENT â€” ${e.driver.name} (${e.team.name}) â€” ${pick(FAIL)}.`}));
  const p2b=Lf(TL,0.55);
  pickN(finishers.slice(0,Math.min(12,finishers.length)),6).forEach((e,i)=>{
    events.push(pitEvent(e,p2b+i*2,2));
  });
  final.forEach((e,fi)=>{
    const ch=(e.gridPos-1)-fi;
    if(!e.dnf&&Math.abs(ch)>=5) events.push({lap:Lf(TL,0.5)+Math.floor(Math.random()*Lf(TL,0.2)),type:ch>0?"charge":"drop",icon:ch>0?"âš¡":"ðŸ“‰",text:ch>0?`${e.driver.name} flying â€” ${ch} places gained from grid!`:`${e.driver.name} drops ${Math.abs(ch)} â€” tyres gone.`});
  });
  if(finishers.length>=3){
    const gS=(((final[1]?.gap||5)*0.35)).toFixed(1);
    events.push({lap:TL-Math.floor(Math.random()*5)-4,type:"battle",icon:"ðŸ",text:`Late in the race: ${finishers[1].driver.name} closing on ${finishers[0].driver.name} â€” gap ${gS}s!`});
  }
  if(finishers[9]&&finishers[10]) events.push({lap:TL-3,type:"battle",icon:"ðŸ”¥",text:`LAP ${TL-3}: ${finishers[9].driver.name} vs ${finishers[10].driver.name} â€” final points position!`});
  const flD=finishers.length>0?pick(finishers.slice(0,Math.min(8,finishers.length))):null;
  let fastestLapSeconds=null, fastestLapSectors=null;
  if(flD){
    const flL=Lf(TL,0.78)+Math.floor(Math.random()*Lf(TL,0.12));
    events.push({lap:flL,type:"fastestlap",icon:"ðŸ’œ",text:`FASTEST LAP: ${flD.driver.name} goes purple on lap ${flL}!`});
    fastestLapSeconds=estimateRaceLapSeconds(track);
    fastestLapSectors=computeSectorTimes(flD, finishers, track, fastestLapSeconds);
  }
  if(finishers.length>=20){
    const[bk1,bk2]=finishers.slice(-4);
    if(bk1&&bk2) events.push({lap:Lf(TL,0.65),type:"battle",icon:"ðŸ”¥",text:`Lap ${Lf(TL,0.65)}: ${bk1.driver.name} and ${bk2.driver.name} â€” their own battle at the back.`});
  }

  // â”€â”€ Mid-race incidents: off-track, gravel, crashes, engine failures, damage â”€
  const _incidentSectors=getTrackSectors(track);
  const _turn=()=>Math.floor(Math.random()*(track.corners||16))+1;
  const _turnToSector=(t)=>{
    const frac=t/(track.corners||16);
    let cum=0;
    for(let i=0;i<_incidentSectors.length;i++){ cum+=_incidentSectors[i].frac; if(frac<=cum||i===_incidentSectors.length-1) return i; }
    return _incidentSectors.length-1;
  };
  // Estimated time an incident-affected driver is shipping in a given sector â€”
  // grounded in their real (weak) sectorEdgeRaw relative to the field, not just flavour.
  const _sectorLossText=(d,team,si)=>{
    const s=_incidentSectors[si];
    const edge=sectorEdgeRaw(d,team,s);
    const avg=entries.reduce((a,e)=>a+sectorEdgeRaw(e.driver,e.team,s),0)/entries.length;
    const weakness=Math.max(0,avg-edge);
    const secs=0.15+Math.random()*0.35+weakness*0.006;
    return secs.toFixed(1)+"s a lap in "+s.name;
  };
  const _fmt=(s,d)=>{
    const t=_turn();
    const si=_turnToSector(t);
    return s.replace(/{d}/g,d.driver.name).replace(/{t}/g,t).replace(/{sec}/g,_incidentSectors[si].name).replace(/{abbr}/g,d.team.abbr||d.team.name);
  };

  // Off-track excursions (1â€“3 per race, more in wet)
  const offTrackCount=isWet?Math.floor(Math.random()*3)+1:Math.floor(Math.random()*2)+(Math.random()<0.55?1:0);
  for(let oi=0;oi<offTrackCount;oi++){
    const offD=pick(entries.filter(e=>!e.dnf||e.dnfLap>Lf(TL,0.15)));
    if(!offD) continue;
    const offLap=Lf(TL,0.08)+Math.floor(Math.random()*Lf(TL,0.78));
    const offMsg=_fmt(pick(OFF_TRACK_MSGS),offD);
    events.push({lap:offLap,type:"incident",icon:"ðŸª¨",text:`Lap ${offLap}: ${offMsg}`});
    // Gravel deposited â€” 70% chance of VSC (higher in wet/street), 15% chance of full SC
    const gravelR=Math.random();
    const scThresh=isWet||track.type==="street"?0.22:0.15;
    const vscThresh=isWet?0.90:0.70;
    if(gravelR<scThresh){
      const gscEnd=offLap+Math.floor(Math.random()*3)+2;
      events.push({lap:offLap,type:"safetycar",icon:"ðŸš—",text:`SAFETY CAR deployed â€” lap ${offLap}. ${_fmt(pick(GRAVEL_MSGS),offD).replace("VIRTUAL SAFETY CAR DEPLOYED","gravel on the racing line")} Marshals need time to clear.`});
      events.push({lap:gscEnd,type:"safetycar",icon:"ðŸŸ¢",text:`Green flag lap ${gscEnd}! Gravel cleared â€” racing resumes.`});
    } else if(gravelR<vscThresh){
      const vscEnd=offLap+Math.floor(Math.random()*2)+1;
      events.push({lap:offLap,type:"vsc",icon:"ðŸŸ¡",text:`VIRTUAL SAFETY CAR â€” lap ${offLap}. ${_fmt(pick(GRAVEL_MSGS),offD)} Clears lap ${vscEnd}.`});
      events.push({lap:vscEnd,type:"vsc",icon:"ðŸŸ¢",text:`VSC ENDING â€” lap ${vscEnd}. Track clear. Gaps frozen during the VSC period.`});
    }
  }

  // Crashes (0â€“3 in wet, 0â€“2 dry; more on street circuits)
  const crashBase=track.type==="street"?0.65:0.40;
  const crashProb=isWet?Math.min(0.95,crashBase+0.30):crashBase;
  const numCrashes=isWet
    ?(Math.random()<0.50?3:Math.random()<0.70?2:1)
    :(Math.random()<crashProb?(Math.random()<0.35?2:1):0);
  for(let ci=0;ci<numCrashes;ci++){
    const crashD=pick(entries.filter(e=>!e.fl1));
    if(!crashD) continue;
    const crashLap=Lf(TL,0.10)+Math.floor(Math.random()*Lf(TL,0.72));
    const crashR=Math.random();
    if(crashR<0.45){
      // DNF crash â€” big impact â†’ SC
      addEventDNF(crashD.driver,crashLap,isWet?"aquaplaned into barrier":"barrier impact");
      const scEndC=crashLap+Math.floor(Math.random()*4)+2;
      events.push({lap:crashLap,type:"dnf",icon:"ðŸ’¥",text:`LAP ${crashLap}: CRASH! ${crashD.driver.name} (${crashD.team.name}) HITS THE BARRIER${isWet?" â€” aquaplaning in the wet":""}! Car is destroyed. DNF.`});
      events.push({lap:crashLap,type:"safetycar",icon:"ðŸš—",text:`SAFETY CAR â€” lap ${crashLap}. Wreckage to clear after the ${crashD.driver.name} incident. Gaps erased.`});
      events.push({lap:scEndC,type:"safetycar",icon:"ðŸŸ¢",text:`Green flag lap ${scEndC}! Debris cleared. Pack sprints into turn 1 â€” fireworks expected.`});
    } else if(crashR<0.75){
      // Significant contact â†’ 5s penalty + VSC or SC
      const secondD=pick(entries.filter(e=>e!==crashD&&!e.dnf));
      addPenalty(crashD.driver,5);
      const scEndC=crashLap+Math.floor(Math.random()*3)+1;
      const deployType=Math.random()<0.5?"safetycar":"vsc";
      events.push({lap:crashLap,type:"incident",icon:"ðŸ’¥",text:`LAP ${crashLap}: COLLISION â€” ${crashD.driver.name} into ${secondD?secondD.driver.name:"the wall"}! Both continue. Stewards investigating.`});
      events.push({lap:crashLap,type:deployType,icon:deployType==="safetycar"?"ðŸš—":"ðŸŸ¡",text:`${deployType==="safetycar"?"SAFETY CAR":"VIRTUAL SAFETY CAR"} â€” lap ${crashLap}. Debris from the contact. 5-SECOND TIME PENALTY for ${crashD.driver.name}.`});
      events.push({lap:scEndC,type:deployType,icon:"ðŸŸ¢",text:`${deployType==="safetycar"?"Green flag":"VSC ending"} lap ${scEndC}. Racing resumes.`});
    } else {
      // Close call â€” minor VSC or nothing
      const secondD=pick(entries.filter(e=>e!==crashD&&!e.dnf));
      events.push({lap:crashLap,type:"incident",icon:"âš ï¸",text:`LAP ${crashLap}: ${crashD.driver.name} and ${secondD?secondD.driver.name:"a backmarker"} make contact â€” both carry on. Damage possible.`});
      if(Math.random()<0.40){
        const vscEndC=crashLap+1;
        events.push({lap:crashLap,type:"vsc",icon:"ðŸŸ¡",text:`VIRTUAL SAFETY CAR â€” lap ${crashLap}. Carbon fibre on the racing line from the ${crashD.driver.name} incident.`});
        events.push({lap:vscEndC,type:"vsc",icon:"ðŸŸ¢",text:`VSC ENDING â€” lap ${vscEndC}. Track clear.`});
      }
    }
  }

  // Engine failures (0â€“2 per race based on reliability)
  const avgReliability=entries.reduce((s,e)=>{const ts=getTeamStats(e.team);return s+(ts.reliability||85);},0)/entries.length;
  const engineFailProb=Math.max(0.12,Math.min(0.55,(105-avgReliability)/100+(isWet?0.08:0)));
  const numEngineFailures=Math.random()<engineFailProb?(Math.random()<0.25?2:1):0;
  for(let ei=0;ei<numEngineFailures;ei++){
    // Prefer midfield/backmarker for engine failure
    const failPool=entries.filter(e=>!e.dnf&&!eventDNFs[e.driver.id]);
    if(failPool.length===0) continue;
    const failD=pick(failPool.slice(Math.floor(failPool.length*0.2)));
    const failLap=Lf(TL,0.12)+Math.floor(Math.random()*Lf(TL,0.70));
    addEventDNF(failD.driver,failLap,pick(["engine failure","power unit failure","hydraulics failure","MGU-K failure"]));
    const msg=_fmt(pick(ENGINE_FAIL_MSGS),failD);
    events.push({lap:failLap,type:"dnf",icon:"ðŸ”§",text:`LAP ${failLap}: ${msg}`});
    // Engine fires / spectacular failures may need VSC
    if(Math.random()<0.45){
      const vscEndE=failLap+1;
      events.push({lap:failLap,type:"vsc",icon:"ðŸŸ¡",text:`VIRTUAL SAFETY CAR â€” lap ${failLap}. ${failD.driver.name}'s stricken car to be recovered from the track.`});
      events.push({lap:vscEndE,type:"vsc",icon:"ðŸŸ¢",text:`VSC ENDING â€” lap ${vscEndE}. Car recovered. Racing resumes at full speed.`});
    }
  }

  // Car damage (mid-race): 0â€“2 incidents affecting pace (not always a DNF)
  const numDamage=Math.random()<(isWet?0.55:0.35)?(Math.random()<0.30?2:1):0;
  for(let di=0;di<numDamage;di++){
    const dmgPool=entries.filter(e=>!e.dnf&&!eventDNFs[e.driver.id]);
    if(dmgPool.length===0) continue;
    const dmgD=pick(dmgPool);
    const dmgLap=Lf(TL,0.15)+Math.floor(Math.random()*Lf(TL,0.65));
    const dmgMsg=_fmt(pick(DAMAGE_MSGS),dmgD);
    const dmgSeverity=Math.random();
    if(dmgSeverity<0.30){
      // Serious â€” DNF (can't continue)
      addEventDNF(dmgD.driver,dmgLap,pick(["suspension failure","puncture â€” barrier impact","brake failure"]));
      events.push({lap:dmgLap,type:"damage",icon:"ðŸ’¥",text:`LAP ${dmgLap}: ${dmgMsg} TERMINAL â€” car cannot continue. DNF for ${dmgD.driver.name}.`});
      if(Math.random()<0.35){
        const vscEndD=dmgLap+1;
        events.push({lap:dmgLap,type:"vsc",icon:"ðŸŸ¡",text:`VIRTUAL SAFETY CAR â€” lap ${dmgLap}. Debris from ${dmgD.driver.name}'s car on the circuit.`});
        events.push({lap:vscEndD,type:"vsc",icon:"ðŸŸ¢",text:`VSC ENDING â€” lap ${vscEndD}. Track clear.`});
      }
    } else {
      // Survivable â€” driver continues but pace is hurt (reflected in commentary,
      // grounded in a real sector-time estimate rather than a generic line)
      const dmgSector=_turnToSector(_turn());
      events.push({lap:dmgLap,type:"damage",icon:"ðŸ”§",text:`LAP ${dmgLap}: ${dmgMsg} Racing on but shipping around ${_sectorLossText(dmgD.driver,dmgD.team,dmgSector)} â€” the damage is costing real time.`});
    }
  }

  // â”€â”€ Apply event-driven DNFs â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Apply event-DNFs â€” mark any driver (finisher or pre-existing DNF) with event reason
  Object.keys(eventDNFs).forEach(function(dId){
    const e=final.find(function(x){return x.driver.id===dId;});
    if(e){
      e.dnf=true;
      e.dnfLap=eventDNFs[dId].lap;
      e.dnfReason=eventDNFs[dId].reason;
    }
  });

  // Deduplicate final by driver id (keep first occurrence only)
  const seenIds={};
  const dedupedFinal=final.filter(function(e){
    const id=e.driver.id;
    if(seenIds[id]) return false;
    seenIds[id]=true;
    return true;
  });

  // Single clean split: active finishers vs DNFs
  const cleanFinishers=dedupedFinal.filter(function(e){return !e.dnf;}).sort(function(a,b){return b.pace-a.pace;});
  const cleanDNFs=dedupedFinal.filter(function(e){return e.dnf;}).sort(function(a,b){return (b.dnfLap||0)-(a.dnfLap||0);});

  // â”€â”€ Compute gaps (finishers only) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  cleanFinishers.forEach(function(e,i){
    if(i===0){e.gap=0;return;}
    const diff=(cleanFinishers[0].pace-e.pace)*0.55;
    const prev=cleanFinishers[i-1].gap||0;
    const gap=Math.max(prev+Math.random()*2.2,diff>0?diff:prev+0.5);
    e.gap=parseFloat(gap.toFixed(3));
  });
  cleanDNFs.forEach(function(e){e.gap=null;});

  // â”€â”€ Apply time penalties and re-sort finishers by effective time â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  cleanFinishers.forEach(function(e){
    const pen=timePenalties[e.driver.id]||0;
    if(pen>0){
      e.timePenalty=pen;
      e.gap=parseFloat(((e.gap||0)+pen).toFixed(3));
    }
  });
  cleanFinishers.sort(function(a,b){return (a.gap||0)-(b.gap||0);});

  // Rebuild final â€” one entry per driver, finishers then DNFs
  final.length=0;
  cleanFinishers.forEach(function(e){final.push(e);});
  cleanDNFs.forEach(function(e){final.push(e);});

  final.forEach((e,i)=>{
    e.finalPos=i+1;
    e.points=(!e.dnf&&i<10)?PTS[i]:0;
    if(flD&&e.driver.id===flD.driver.id&&!e.dnf&&i<10) e.points+=1;
  });

  events.push(...genRaceSectorEvents(final, track, TL));

  events.sort((a,b)=>a.lap-b.lap);

  // â”€â”€ Quarter standings: shuffle final order by decreasing amounts each quarter â”€â”€
  // Q1 is very chaotic (big swaps), each quarter settles toward the true final order.
  // Gap timings are fresh per quarter with stage-appropriate scales.
  const quarterStandings = buildQuarterStandings(final, TL, quarterWeather);

  return {positions:final,events,fastestLap:flD?.driver||null,fastestLapSeconds,fastestLapSectors,isWet,hasSC,scLap,totalLaps:TL,quarterStandings,quarterWeather,dryingLap,hasRF,rfLap,rfResumeLap};
}

// ===================== CANVAS DOWNLOAD =====================

function downloadStage(lines, stageDef, track) {
  const W=1200, PAD=44, AV=36;
  const colX=PAD+AV+14, textMaxW=W-colX-PAD-20;
  const tmp=document.createElement("canvas").getContext("2d");
  tmp.font="15px Arial,sans-serif";
  const wrapped=lines.map(l=>{
    const words=l.text.split(" "), tls=[];
    let cur="";
    words.forEach(w=>{
      const t=cur?cur+" "+w:w;
      if(tmp.measureText(t).width>textMaxW&&cur){tls.push(cur);cur=w;}
      else cur=t;
    });
    if(cur) tls.push(cur);
    return {...l,tls};
  });
  let H=130;
  wrapped.forEach(l=>{H+=20+l.tls.length*22+24+14;});
  H+=30;
  const canvas=document.createElement("canvas");
  canvas.width=W; canvas.height=H;
  const c=canvas.getContext("2d");
  c.fillStyle="#0C0C0F"; c.fillRect(0,0,W,H);
  c.fillStyle=stageDef.color; c.fillRect(0,0,W,5);
  c.fillStyle="#111115"; c.fillRect(0,5,W,95);
  c.font="bold 26px Arial,sans-serif"; c.fillStyle=stageDef.color;
  c.fillText(stageDef.title,PAD,46);
  c.font="14px Arial,sans-serif"; c.fillStyle="#bbb";
  c.fillText(track.name+" | "+track.circuit,PAD,72);
  c.font="bold 16px Arial,sans-serif"; c.fillStyle="#E8002D";
  c.fillText("F1 SIM",W-PAD-80,46);
  c.font="12px Arial,sans-serif"; c.fillStyle="#778";
  c.fillText("2027 SEASON",W-PAD-80,68);
  c.strokeStyle="#222"; c.lineWidth=1;
  c.beginPath(); c.moveTo(0,100); c.lineTo(W,100); c.stroke();
  let y=118;
  wrapped.forEach(line=>{
    const ic=line.speaker==="CROFT";
    const col=ic?"#E8002D":"#4466AA";
    const bg=ic?"#1A0808":"#080818";
    const tc=ic?"#E8D8D8":"#D0D8E8";
    const lh=line.tls.length*22+20;
    c.beginPath(); c.arc(PAD+AV/2,y+12,AV/2,0,Math.PI*2);
    c.fillStyle=bg; c.fill();
    c.strokeStyle=col; c.lineWidth=2; c.stroke();
    c.font="bold 10px Arial,sans-serif";
    c.fillStyle=ic?"#fff":col; c.textAlign="center";
    c.fillText(ic?"DC":"MB",PAD+AV/2,y+16); c.textAlign="left";
    c.font="bold 10px Arial,sans-serif"; c.fillStyle=col;
    c.fillText(ic?"DAVID CROFT":"MARTIN BRUNDLE",colX,y+12);
    c.fillStyle=bg; c.fillRect(colX,y+18,W-colX-PAD,lh);
    c.fillStyle=col; c.fillRect(colX,y+18,3,lh);
    c.font="15px Arial,sans-serif"; c.fillStyle=tc;
    line.tls.forEach((tl,ti)=>c.fillText(tl,colX+12,y+34+ti*22));
    y+=lh+14+20;
  });
  c.font="11px Arial,sans-serif"; c.fillStyle="#bbb";
  c.fillText("Generated by F1 SIM",PAD,H-12);
  canvas.toBlob(blob=>{
    if(!blob)return;
    const url=URL.createObjectURL(blob);
    const a=document.createElement("a");
    a.href=url; a.download=`${track.circuit.replace(/\s+/g,"-").toLowerCase()}-${stageDef.key}.png`;
    document.body.appendChild(a); a.click();
    setTimeout(()=>{document.body.removeChild(a);URL.revokeObjectURL(url);},100);
  });
}

// â”€â”€ Leaderboard PNG export â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function downloadLeaderboardPNG(title,subtitle,entries,color,filename,opts={}){
  const W=1100,PAD=40,ROW=54;
  const H=110+entries.length*ROW+44;
  const canvas=document.createElement("canvas");
  canvas.width=W; canvas.height=H;
  const c=canvas.getContext("2d");
  c.fillStyle="#0C0C0F"; c.fillRect(0,0,W,H);
  c.fillStyle=color; c.fillRect(0,0,W,5);
  c.fillStyle="#111115"; c.fillRect(0,5,W,88);
  c.font="bold 24px Arial,sans-serif"; c.fillStyle=color; c.fillText(title,PAD,44);
  c.font="14px Arial,sans-serif"; c.fillStyle="#aaa"; c.fillText(subtitle,PAD,68);
  c.textAlign="right";
  c.font="bold 14px Arial,sans-serif"; c.fillStyle="#E8002D"; c.fillText("F1 SIM",W-PAD,42);
  c.font="11px Arial,sans-serif"; c.fillStyle="#556"; c.fillText("2027 SEASON",W-PAD,62);
  c.textAlign="left";
  c.strokeStyle="#1E1E22"; c.lineWidth=1;
  c.beginPath(); c.moveTo(0,93); c.lineTo(W,93); c.stroke();
  let y=100;
  entries.forEach((e,i)=>{
    const tColor=e.team?.color||e.teamColor||"#888";
    const isDNF=!!e.dnf;
    c.fillStyle=isDNF?"#180E0E":i<3?"#181810":"#111115";
    c.fillRect(0,y,W,ROW-2);
    c.fillStyle=isDNF?"#FF4444":tColor;
    c.fillRect(0,y,4,ROW-2);
    c.fillStyle=i===0?color:i===1?"#909090":i===2?"#CD7F32":"#1E1E26";
    c.fillRect(PAD,y+10,34,34);
    c.font=isDNF?"bold 9px Arial":"bold 14px Arial";
    c.fillStyle=i<3?"#000":"#666";
    c.textAlign="center";
    c.fillText(isDNF?"DNF":String(i+1),PAD+17,y+33);
    c.textAlign="left";
    c.font="bold 15px Arial,sans-serif"; c.fillStyle="#F0F0F0";
    c.fillText((e.driver?.flag||"")+" "+(e.driver?.name||e.driverName||""),PAD+50,y+26);
    c.font="12px Arial,sans-serif"; c.fillStyle=tColor;
    c.fillText(e.team?.name||e.teamName||"",PAD+50,y+44);
    c.textAlign="right";
    if(isDNF){
      c.font="bold 13px Arial,sans-serif"; c.fillStyle="#FF4444";
      c.fillText("DNF Lap "+(e.dnfLap||"?"),W-PAD,y+26);
      if(e.dnfReason){c.font="11px Arial"; c.fillStyle="#FF6644"; c.fillText(e.dnfReason,W-PAD,y+44);}
    }else if(opts.refQualSecs){
      // Show actual lap times (qualifying / FP / testing mode)
      const fmtT=s=>{const m=Math.floor(s/60);return m+":"+(s%60).toFixed(3).padStart(6,"0");};
      const gapVal=e.gap!=null?parseFloat(e.gap):(e.gapStr!=null?parseFloat(e.gapStr):0);
      const lapT=fmtT(opts.refQualSecs+(i===0?0:gapVal));
      c.font="bold 16px monospace"; c.fillStyle=i===0?color:"#F0F0F0";
      c.fillText(lapT,W-PAD,y+26);
      if(i>0&&gapVal){c.font="11px Arial"; c.fillStyle="#778"; c.fillText("+"+e.gap+"s",W-PAD,y+44);}
      if(opts.showLaps&&e.laps){c.font="11px Arial"; c.fillStyle="#556"; c.fillText(e.laps+" laps",W-PAD,y+46);}
    }else{
      const gap=e.gap!=null?e.gap:(e.gapStr!=null?e.gapStr:null);
      const gapTxt=i===0?(opts.leaderLabel||"LEADER"):(gap!==null?"+"+gap+"s":"â€”");
      c.font="bold 15px monospace"; c.fillStyle=i===0?color:"#bbb";
      c.fillText(gapTxt,W-PAD,y+26);
      if(opts.showPoints&&e.points>0){c.font="12px Arial"; c.fillStyle="#E8002D"; c.fillText("+"+e.points+"pts",W-PAD,y+44);}
      if(opts.showLaps&&e.laps){c.font="11px Arial"; c.fillStyle="#556"; c.fillText(e.laps+" laps",W-PAD,y+44);}
    }
    c.textAlign="left";
    y+=ROW;
  });
  c.font="10px Arial"; c.fillStyle="#333";
  c.fillText("Generated by F1 SIM · 2027 Season",PAD,H-10);
  canvas.toBlob(blob=>{
    if(!blob)return;
    const url=URL.createObjectURL(blob);
    const a=document.createElement("a");
    a.href=url; a.download=filename||"f1sim-leaderboard.png";
    document.body.appendChild(a); a.click();
    setTimeout(()=>{document.body.removeChild(a);URL.revokeObjectURL(url);},100);
  });
}

// â”€â”€ Weekend CSV/Excel export â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function exportWeekendCSV(track,sessions){
  const BOM='ï»¿';
  const esc=s=>{const v=String(s??"");return(v.includes(",")||v.includes('"')||v.includes("\n"))?'"'+v.replace(/"/g,'""')+'"':v;};
  const row=arr=>arr.map(esc).join(",");
  const rows=[];
  rows.push(row(["F1 SIM â€” "+track.name,track.circuit,"","","",""]));
  rows.push(row(["Exported: "+new Date().toLocaleString()]));
  rows.push("");
  const addPos=(label,positions,gapFn,showPoints,showLaps)=>{
    if(!positions?.length)return;
    rows.push(row(["=== "+label+" ==="]));
    const hasSectors=positions.some(e=>e.sectors);
    const h=["Pos","Driver","Team","Gap / Status"];
    if(showLaps)h.push("Laps");
    if(showPoints)h.push("Points");
    if(hasSectors)h.push("S1","S2","S3","Lap Time");
    h.push("Notes");
    rows.push(row(h));
    positions.forEach((e,i)=>{
      const dn=e.driver?.name||e.driverName||"";
      const tn=e.team?.name||e.teamName||"";
      let g="";
      if(e.dnf) g="DNF Lap "+(e.dnfLap||"?")+(e.dnfReason?" â€” "+e.dnfReason:"");
      else if(i===0) g="LEADER";
      else g=gapFn?gapFn(e,i):(e.gap!=null?"+"+e.gap+"s":"");
      const cells=[e.dnf?"DNF":String(i+1),dn,tn,g];
      if(showLaps)cells.push(e.laps||"");
      if(showPoints)cells.push(e.points||0);
      if(hasSectors){
        if(e.sectors){cells.push(e.sectors[0].toFixed(3),e.sectors[1].toFixed(3),e.sectors[2].toFixed(3),e.lapSeconds.toFixed(3));}
        else{cells.push("","","","");}
      }
      const notes=[e.timePenalty?"+"+e.timePenalty+"s penalty":"",e.incidents>0?e.incidents+" incident(s)":""].filter(Boolean).join(", ");
      cells.push(notes);
      rows.push(row(cells));
    });
    rows.push("");
  };
  const addEvts=(label,events)=>{
    if(!events?.length)return;
    rows.push(row(["=== "+label+" ==="]));
    rows.push(row(["Lap","Type","Description"]));
    events.forEach(ev=>rows.push(row([ev.lap,ev.type,ev.text])));
    rows.push("");
  };
  const qGap=src=>(e,i)=>"+"+((src[0].score-e.score)*0.011).toFixed(3)+"s";
  const{fp1,fp2,sprintQual,qual,sprint,race}=sessions;
  if(fp1)addPos("FREE PRACTICE 1",fp1.positions,null,false,true);
  if(fp2)addPos("FREE PRACTICE 2",fp2.positions,null,false,true);
  if(sprintQual){
    addPos("SPRINT QUALIFYING 1 (SQ1)",sprintQual.sq1,qGap(sprintQual.sq1));
    addPos("SPRINT QUALIFYING 2 (SQ2)",sprintQual.sq2,qGap(sprintQual.sq2));
    addPos("SPRINT QUALIFYING 3 (SQ3)",sprintQual.sq3,qGap(sprintQual.sq3));
    if(sprintQual.sq1Events)addEvts("SQ1 EVENTS",sprintQual.sq1Events);
    if(sprintQual.sq2Events)addEvts("SQ2 EVENTS",sprintQual.sq2Events);
    if(sprintQual.sq3Events)addEvts("SQ3 EVENTS",sprintQual.sq3Events);
  }
  if(qual){
    addPos("QUALIFYING Q1",qual.q1,qGap(qual.q1));
    addPos("QUALIFYING Q2",qual.q2,qGap(qual.q2));
    addPos("QUALIFYING Q3",qual.q3,qGap(qual.q3));
    if(qual.q1Events)addEvts("Q1 EVENTS",qual.q1Events);
    if(qual.q2Events)addEvts("Q2 EVENTS",qual.q2Events);
    if(qual.q3Events)addEvts("Q3 EVENTS",qual.q3Events);
  }
  if(sprint){addPos("SPRINT RACE",sprint.positions,null,true);if(sprint.events)addEvts("SPRINT EVENTS",sprint.events);}
  if(race){
    addPos("GRAND PRIX â€” FINAL CLASSIFICATION",race.positions,null,true);
    if(race.events)addEvts("RACE EVENTS",race.events);
    if(race.fastestLap){
      const flCells=["Fastest Lap: "+race.fastestLap.name,race.fastestLap.team?.name||"","",""];
      if(race.fastestLapSectors)flCells.push(race.fastestLapSectors.map((s,si)=>"S"+(si+1)+" "+s.toFixed(3)).join(" / "),race.fastestLapSeconds.toFixed(3));
      rows.push(row(flCells));
    }
  }
  const csv=BOM+rows.join("\n");
  const blob=new Blob([csv],{type:"text/csv;charset=utf-8;"});
  const url=URL.createObjectURL(blob);
  const a=document.createElement("a");
  a.href=url; a.download="f1sim-"+track.id+"-weekend.csv";
  document.body.appendChild(a); a.click();
  setTimeout(()=>{document.body.removeChild(a);URL.revokeObjectURL(url);},100);
}

// â”€â”€ Testing CSV/Excel export â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function exportTestingCSV(testResults,testSession){
  const BOM='ï»¿';
  const esc=s=>{const v=String(s??"");return(v.includes(",")||v.includes('"'))?'"'+v.replace(/"/g,'""')+'"':v;};
  const row=arr=>arr.map(esc).join(",");
  const rows=[];
  rows.push(row(["F1 SIM â€” "+testSession.name,testSession.dates||""]));
  rows.push(row(["Exported: "+new Date().toLocaleString()]));
  rows.push("");
  rows.push(row(["=== OVERALL STANDINGS ==="]));
  rows.push(row(["Pos","Driver","Team","Best Lap","Race Sim (long run)","Total Laps","Issues"]));
  testResults.overall.forEach((r,i)=>{
    rows.push(row([i+1,r.driver.name,r.team.name,
      r.bestLap?r.bestLap.toFixed(3):"",
      r.longRun?r.longRun.toFixed(3):"",
      r.laps,
      (r.issues||[]).map(iss=>"Day"+iss.day+": "+iss.type).join("; ")]));
  });
  rows.push("");
  testResults.days.forEach(day=>{
    rows.push(row(["=== DAY "+day.day+" â€” "+day.conditions.label+" ==="]));
    rows.push(row(["Pos","Driver","Team","Best Lap","Race Sim","Laps","Programme","Issue"]));
    day.results.forEach((r,i)=>{
      const prog=[r.didQualiRun?"Q-sim":"",r.didLongRun?"Long run":"",(!r.didQualiRun&&!r.didLongRun)?"Install":""].filter(Boolean).join(", ");
      rows.push(row([i+1,r.driver.name,r.team.name,
        r.bestLap?r.bestLap.toFixed(3):"",
        r.longRun?r.longRun.toFixed(3):"",
        r.laps,prog,
        r.issue?r.issue.type+" ("+r.issue.severity+")":""]));
    });
    if(day.incidents?.length){
      rows.push("");
      rows.push(row(["=== DAY "+day.day+" INCIDENTS ==="]));
      rows.push(row(["Driver","Team","Issue","Session","Severity","Laps Lost"]));
      day.incidents.forEach(inc=>rows.push(row([inc.driver.name,inc.team.name,inc.issue.type,inc.issue.session,inc.issue.severity,inc.issue.lapLost])));
    }
    rows.push("");
  });
  const csv=BOM+rows.join("\n");
  const blob=new Blob([csv],{type:"text/csv;charset=utf-8;"});
  const url=URL.createObjectURL(blob);
  const a=document.createElement("a");
  a.href=url; a.download="f1sim-testing-"+(testSession.id||"test")+".csv";
  document.body.appendChild(a); a.click();
  setTimeout(()=>{document.body.removeChild(a);URL.revokeObjectURL(url);},100);
}

// ===================== HELPERS =====================

function buildSurnameMap(drivers,teams){
  const m={};
  drivers.forEach(d=>{
    const sn=d.name.split(" ").pop();
    const t=teams.find(t=>t.id===d.teamId);
    m[sn]=t?.color||"#E8002D";
  });
  return m;
}

// ===================== COMPONENTS =====================

function HighlightedText({text,surnameMap}){
  if(!text)return null;
  const sn=Object.keys(surnameMap).sort((a,b)=>b.length-a.length);
  const esc=s=>s.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
  const re=new RegExp(`\\b(${sn.map(esc).join("|")})\\b`,"g");
  const parts=[]; let last=0,m;
  re.lastIndex=0;
  while((m=re.exec(text))!==null){
    if(m.index>last) parts.push({t:text.slice(last,m.index),c:null});
    parts.push({t:m[1],c:surnameMap[m[1]]});
    last=re.lastIndex;
  }
  if(last<text.length) parts.push({t:text.slice(last),c:null});
  return <span>{parts.map((p,i)=>p.c?<span key={i} style={{color:p.c,fontWeight:700,textShadow:`0 0 14px ${p.c}44`}}>{p.t}</span>:<span key={i}>{p.t}</span>)}</span>;
}

function DialogueLine({speaker,text,surnameMap}){
  const ic=speaker==="CROFT";
  return(
    <div style={{display:"flex",gap:14,marginBottom:16,alignItems:"flex-start"}}>
      <div style={{flexShrink:0,width:46,height:46,borderRadius:"50%",background:ic?"#E8002D22":"#08081A",border:`2px solid ${ic?"#E8002D":"#4466AA"}`,display:"flex",alignItems:"center",justifyContent:"center"}}>
        <span style={{fontSize:13,fontWeight:900,color:ic?"#E8002D":"#4466AA"}}>{ic?"DC":"MB"}</span>
      </div>
      <div style={{flex:1}}>
        <div style={{fontSize:13,fontWeight:700,letterSpacing:2.5,color:ic?"#E8002D":"#6688BB",marginBottom:5}}>{ic?"DAVID CROFT":"MARTIN BRUNDLE"}</div>
        <div style={{background:ic?"#160A0A":"#0A0A16",border:`1px solid ${ic?"#E8002D22":"#4466AA22"}`,borderLeft:`3px solid ${ic?"#E8002D":"#4466AA"}`,borderRadius:"0 8px 8px 0",padding:"11px 16px",lineHeight:1.85,fontSize:17,color:ic?"#E8D8D8":"#D0D8E8"}}>
          <HighlightedText text={text} surnameMap={surnameMap}/>
        </div>
      </div>
    </div>
  );
}

function Bar({val,color="#E8002D",max=100}){
  return <div style={{height:6,background:"#2A2A30",borderRadius:3,marginTop:4}}><div style={{height:6,width:`${(val/max)*100}%`,background:color,borderRadius:2}}/></div>;
}

function MentalBar({val,color}){
  const mentalColor=val>=8?"#44CC88":val>=6?"#FFC906":val>=4?"#FF8844":"#FF4444";
  return(
    <div style={{marginBottom:4}}>
      <div style={{display:"flex",justifyContent:"space-between",fontSize:12,color:"#778",letterSpacing:1.5}}><span>MENTAL</span><span style={{color:mentalColor}}>{val}/10</span></div>
      <div style={{height:6,background:"#2A2A30",borderRadius:3,marginTop:3}}>
        <div style={{height:6,width:`${val*10}%`,background:mentalColor,borderRadius:2}}/>
      </div>
    </div>
  );
}

function TrackPicker({goodTracks,badTracks,onChange}){
  const toggle=id=>{
    if(goodTracks.includes(id)) onChange({goodTracks:goodTracks.filter(x=>x!==id),badTracks});
    else if(badTracks.includes(id)) onChange({goodTracks,badTracks:badTracks.filter(x=>x!==id)});
    else if(goodTracks.length<3) onChange({goodTracks:[...goodTracks,id],badTracks});
    else if(badTracks.length<3) onChange({goodTracks,badTracks:[...badTracks,id]});
  };
  return(
    <div style={{marginBottom:12}}>
      <div style={{fontSize:12,color:"#899",letterSpacing:1.5,marginBottom:6}}>
        CLICK TO TOGGLE: ðŸŸ¢ GOOD TRACK (+5 PTS) · ðŸ”´ BAD TRACK (âˆ’5 PTS) · MAX 3 EACH
      </div>
      <div style={{display:"flex",flexWrap:"wrap",gap:3}}>
        {TRACKS.map(t=>{
          const g=goodTracks.includes(t.id),b=badTracks.includes(t.id);
          return(
            <button key={t.id} onClick={()=>toggle(t.id)} style={{fontSize:12,padding:"3px 6px",cursor:"pointer",fontFamily:"inherit",fontWeight:700,border:"none",borderRadius:2,transition:"all 0.1s",background:g?"#44CC8828":b?"#FF444428":"#2A2A30",color:g?"#44CC88":b?"#FF4444":"#899",outline:g?`1px solid #44CC8866`:b?`1px solid #FF444466`:"none"}}>
              {t.flag} {t.id.slice(0,3).toUpperCase()}
            </button>
          );
        })}
      </div>
      <div style={{fontSize:12,color:"#899",marginTop:5}}>ðŸŸ¢ {goodTracks.length}/3 favourites · ðŸ”´ {badTracks.length}/3 tough circuits</div>
    </div>
  );
}

function RivalPicker({rivals, currentDriverId, allDrivers, onChange}) {
  const available = allDrivers.filter(d=>d.id!==currentDriverId);
  const toggle = (id) => {
    if(rivals.includes(id)) {
      onChange(rivals.filter(r=>r!==id));
    } else if(rivals.length<3) {
      onChange([...rivals, id]);
    }
  };
  return(
    <div style={{marginBottom:4}}>
      <div style={{fontSize:12,color:"#778",marginBottom:8,lineHeight:1.5}}>
        Select up to 3 rivals â€” they trigger special commentary moments in qualifying, sprints and races.
        <span style={{color:"#aaa",marginLeft:5}}>{rivals.length}/3 selected</span>
      </div>
      {/* Selected rivals shown first */}
      {rivals.length>0&&(
        <div style={{display:"flex",flexWrap:"wrap",gap:5,marginBottom:8}}>
          {rivals.map(rid=>{
            const d=allDrivers.find(x=>x.id===rid);
            if(!d) return null;
            return(
              <button key={rid} type="button" onClick={()=>toggle(rid)}
                style={{display:"flex",alignItems:"center",gap:5,background:"#E8002D1A",border:"1px solid #E8002D66",borderRadius:3,padding:"4px 9px",cursor:"pointer",color:"#E8002D",fontSize:12,fontWeight:700}}>
                {d.flag} {d.name.split(" ").pop()}
                <span style={{fontSize:10,opacity:0.7}}>Ã—</span>
              </button>
            );
          })}
        </div>
      )}
      {/* Driver select dropdown */}
      <select
        value=""
        onChange={e=>{if(e.target.value) toggle(e.target.value);}}
        style={{width:"100%",background:"#1E1E22",border:"1px solid #333",color:"#F0F0F0",padding:"8px 10px",fontFamily:"inherit",fontSize:13,borderRadius:3,cursor:"pointer"}}>
        <option value="">
          {rivals.length>=3?"Maximum 3 rivals selected":"+ Add rival..."}
        </option>
        {available.filter(d=>!rivals.includes(d.id)).map(d=>(
          <option key={d.id} value={d.id}>{d.flag} {d.name}</option>
        ))}
      </select>
      {rivals.length===0&&(
        <div style={{fontSize:11,color:"#555",marginTop:5}}>No rivals set â€” this driver has no special narrative triggers.</div>
      )}
    </div>
  );
}


function RoundDetail({r, onBack}) {
  const [detailTab, setDetailTab] = useState("race");
  const [qDt, setQDt] = useState("q3");
  const snap = r.snapshot;
  if (!snap) return null;
  // Build weekend session sub-tabs
  const wkndTabs = [];
  if(snap.fp1) wkndTabs.push({k:"fp1",l:"FP1",kind:"fp",data:snap.fp1,color:"#4488FF"});
  if(snap.fp2) wkndTabs.push({k:"fp2",l:"FP2",kind:"fp",data:snap.fp2,color:"#44AAFF"});
  if(snap.sprintQual){
    wkndTabs.push({k:"sq1",l:"SQ1",kind:"sq",src:snap.sprintQual.sq1,elimLine:12,color:"#BB66FF"});
    wkndTabs.push({k:"sq2",l:"SQ2",kind:"sq",src:snap.sprintQual.sq2,elimLine:8,color:"#DD88FF"});
    wkndTabs.push({k:"sq3",l:"SQ3",kind:"sq",src:snap.sprintQual.sq3,elimLine:null,color:"#FF66FF"});
  }
  if(snap.qual){
    wkndTabs.push({k:"q1",l:"Q1",kind:"q",src:snap.qual.q1,elimLine:15,color:"#FF8844"});
    wkndTabs.push({k:"q2",l:"Q2",kind:"q",src:snap.qual.q2,elimLine:10,color:"#FFC906"});
    wkndTabs.push({k:"q3",l:"Q3",kind:"q",src:snap.qual.q3,elimLine:null,color:"#E8002D"});
  }
  const curW = wkndTabs.find(t=>t.k===qDt) || wkndTabs.find(t=>t.k==="q3") || wkndTabs[wkndTabs.length-1];
  return(
    <div style={{animation:"fadeIn 0.2s ease"}}>
      {/* Back + header */}
      <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:16}}>
        <button onClick={onBack} style={{background:"#2A2A30",color:"#ccc",border:"none",padding:"7px 14px",cursor:"pointer",fontFamily:"inherit",fontSize:13,fontWeight:700,borderRadius:3}}>â† BACK</button>
        <div>
          <div style={{fontSize:20,fontWeight:700}}>{r.trackFlag} {r.trackName} â€” Round {r.round}</div>
          <div style={{fontSize:12,color:"#778",marginTop:2}}>{r.trackCircuit||""} {r.hasSprint?"· âš¡ Sprint Weekend":""} · Read-only snapshot</div>
        </div>
      </div>
      {/* Sub-tabs */}
      <div style={{display:"flex",gap:3,marginBottom:14,background:"#0D0D10",padding:4,borderRadius:4,border:"1px solid #1E1E22"}}>
        {[["race","ðŸ RACE"],wkndTabs.length>0?["qual","ðŸ“‹ WEEKEND"]:null,snap.sprint?["sprint","âš¡ SPRINT"]:null].filter(Boolean).map(([k,l])=>(
          <button key={k} onClick={()=>setDetailTab(k)}
            style={{flex:1,background:detailTab===k?"#2A2A30":"transparent",color:detailTab===k?"#F0F0F0":"#778",border:"none",padding:"7px 0",cursor:"pointer",fontFamily:"inherit",fontSize:13,fontWeight:700,letterSpacing:1,borderRadius:3}}>
            {l}
          </button>
        ))}
      </div>
      {/* RACE */}
      {detailTab==="race"&&snap.race&&(
        <div style={{display:"grid",gridTemplateColumns:"1fr 360px",gap:14,alignItems:"start"}}>
          <div>
            <div style={{fontSize:11,color:"#778",letterSpacing:2,marginBottom:8}}>RACE CLASSIFICATION · {snap.race.totalLaps} LAPS</div>
            <div style={{display:"flex",gap:6,marginBottom:10,flexWrap:"wrap"}}>
              {snap.race.isWet&&<span style={{background:"#4488FF18",color:"#4488FF",fontSize:11,fontWeight:700,padding:"2px 7px",borderRadius:2}}>ðŸŒ§ï¸ WET</span>}
              {snap.race.hasSC&&<span style={{background:"#FFC90618",color:"#FFC906",fontSize:11,fontWeight:700,padding:"2px 7px",borderRadius:2}}>ðŸš— SC LAP {snap.race.scLap}</span>}
              {snap.race.fastestLapName&&<span style={{background:"#CC44FF18",color:"#CC44FF",fontSize:11,fontWeight:700,padding:"2px 7px",borderRadius:2}}>ðŸ’œ FL: {snap.race.fastestLapName}</span>}
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:5}}>
              {snap.race.positions.map((e,i)=>(
                <div key={e.driverId||i} style={{display:"flex",alignItems:"center",gap:9,padding:"8px 11px",background:e.dnf?"#1A1010":i<3?"#181810":"#161618",border:`1px solid ${e.dnf?"#FF444418":i<3?"#FFC90618":"#1E1E22"}`,borderLeft:`3px solid ${e.dnf?"#FF4444":e.teamColor}`,borderRadius:3,opacity:e.dnf?0.65:1}}>
                  <div style={{width:26,height:26,display:"flex",alignItems:"center",justifyContent:"center",background:i===0?"#FFC906":i===1?"#aaa":i===2?"#CD7F32":"transparent",color:i<3?"#000":"#bbb",fontSize:11,fontWeight:700,borderRadius:2,border:i>=3?"1px solid #2A2A30":"none",flexShrink:0}}>{e.dnf?"DNF":i+1}</div>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontSize:13,fontWeight:700,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{e.driverFlag} {e.driverName}</div>
                    <div style={{fontSize:11,color:e.teamColor,letterSpacing:1}}>{e.teamName}</div>
                  </div>
                  <div style={{textAlign:"right",flexShrink:0}}>
                    {e.dnf?<div style={{fontSize:11,color:"#FF4444"}}>L{e.dnfLap}</div>
                          :<><div style={{fontSize:12,fontFamily:"monospace",color:i===0?"#FFC906":"#bbb"}}>{i===0?"ðŸ WIN":`+${e.gap}s`}</div>{e.points>0&&<div style={{fontSize:11,color:"#E8002D",fontWeight:700}}>+{e.points}pts</div>}</>}
                  </div>
                </div>
              ))}
            </div>
          </div>
          {snap.race.events&&snap.race.events.length>0&&(
            <div style={{position:"sticky",top:16}}>
              <div style={{fontSize:11,color:"#778",letterSpacing:2,marginBottom:8}}>RACE EVENTS</div>
              <div style={{maxHeight:"calc(100vh - 280px)",overflowY:"auto"}}>
                {snap.race.events.map((ev,i)=>(
                  <div key={i} style={{borderLeft:`3px solid ${EVT_C[ev.type]||"#555"}`,padding:"6px 10px",marginBottom:4,background:"#161618",borderRadius:"0 3px 3px 0"}}>
                    {ev.lap>0&&<div style={{fontSize:10,color:"#778",marginBottom:1}}>LAP {ev.lap}</div>}
                    <div style={{fontSize:12,lineHeight:1.5}}>{ev.icon} {ev.text}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
      {/* WEEKEND (FP + SQ + Qual) */}
      {detailTab==="qual"&&wkndTabs.length>0&&(
        <>
          <div style={{display:"flex",gap:3,marginBottom:12,background:"#0D0D10",padding:4,borderRadius:4,border:"1px solid #1E1E22",flexWrap:"wrap"}}>
            {wkndTabs.map(t=>(
              <button key={t.k} onClick={()=>setQDt(t.k)}
                style={{flex:1,minWidth:42,background:qDt===t.k?`${t.color}22`:"transparent",color:qDt===t.k?t.color:"#556",border:`1px solid ${qDt===t.k?t.color+"55":"transparent"}`,padding:"6px 0",cursor:"pointer",fontFamily:"inherit",fontSize:12,fontWeight:700,borderRadius:3}}>
                {t.l}
              </button>
            ))}
          </div>
          {snap.qual?.runsUsed>1&&<div style={{fontSize:12,color:"#E8002D",marginBottom:8}}>âŸ³ Averaged over Ã—{snap.qual.runsUsed} runs</div>}
          {/* FP tab */}
          {curW&&curW.kind==="fp"&&(
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:5}}>
              {curW.data.map((e,i)=>(
                <div key={e.driverAbbr||i} style={{display:"flex",alignItems:"center",gap:9,padding:"8px 11px",background:"#161618",border:"1px solid #1E1E22",borderLeft:`3px solid ${e.teamColor}`,borderRadius:3}}>
                  <div style={{width:26,textAlign:"center",fontSize:12,fontWeight:700,color:i<3?"#FFC906":"#556"}}>{i+1}</div>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontSize:13,fontWeight:700,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{e.driverFlag} {e.driverName}</div>
                    <div style={{fontSize:11,color:e.teamColor}}>{e.teamName}</div>
                  </div>
                  <div style={{textAlign:"right"}}>
                    <div style={{fontSize:12,fontFamily:"monospace",color:i===0?"#FFC906":"#aaa"}}>{i===0?"BEST":`+${e.gap}s`}</div>
                    <div style={{fontSize:10,color:"#445"}}>{e.laps} laps</div>
                  </div>
                </div>
              ))}
            </div>
          )}
          {/* SQ tab */}
          {curW&&curW.kind==="sq"&&curW.src&&(
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:5}}>
              {[...curW.src].sort((a,b)=>b.score-a.score).map((e,i)=>{
                const sorted=[...curW.src].sort((a2,b2)=>b2.score-a2.score);
                const elim=curW.elimLine!=null&&i>=curW.elimLine;
                const gap=i===0?null:(sorted[0].score-e.score)*0.011;
                return(
                  <div key={e.driver.id||i} style={{display:"flex",alignItems:"center",gap:9,padding:"8px 11px",background:elim?"#1A1010":i<3?"#181810":"#161618",border:`1px solid ${elim?"#FF444433":i<3?"#FFC90618":"#1E1E22"}`,borderLeft:`3px solid ${elim?"#FF4444":e.team.color}`,borderRadius:3,opacity:elim?0.55:1}}>
                    <div style={{width:26,height:26,display:"flex",alignItems:"center",justifyContent:"center",background:i===0?"#FFC906":i===1?"#aaa":i===2?"#CD7F32":"transparent",color:i<3?"#000":"#bbb",fontSize:11,fontWeight:700,borderRadius:2,border:i>=3?"1px solid #2A2A30":"none",flexShrink:0}}>{i+1}</div>
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{fontSize:13,fontWeight:700,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{e.driver.flag} {e.driver.name}</div>
                      <div style={{fontSize:11,color:e.team.color}}>{e.team.name}</div>
                    </div>
                    <div style={{textAlign:"right",flexShrink:0}}>
                      <div style={{fontSize:12,fontFamily:"monospace",color:i===0?curW.color:"#aaa"}}>{i===0?"P1":gap?"+"+gap.toFixed(3)+"s":""}</div>
                      {elim&&<div style={{fontSize:10,color:"#FF4444",fontWeight:700}}>ELIM</div>}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {/* Q tab */}
          {curW&&curW.kind==="q"&&curW.src&&(
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:5}}>
              {[...curW.src].sort((a,b)=>b.score-a.score).map((e,i)=>{
                const sorted=[...curW.src].sort((a2,b2)=>b2.score-a2.score);
                const elim=curW.elimLine!=null&&i>=curW.elimLine;
                const gap=i===0?null:(sorted[0].score-e.score)*0.011;
                return(
                  <div key={e.driver.id||i} style={{display:"flex",alignItems:"center",gap:9,padding:"8px 11px",background:elim?"#1A1010":i<3?"#181810":"#161618",border:`1px solid ${elim?"#FF444433":i<3?"#FFC90618":"#1E1E22"}`,borderLeft:`3px solid ${elim?"#FF4444":e.team.color}`,borderRadius:3,opacity:elim?0.55:1}}>
                    <div style={{width:26,height:26,display:"flex",alignItems:"center",justifyContent:"center",background:i===0?"#FFC906":i===1?"#aaa":i===2?"#CD7F32":"transparent",color:i<3?"#000":"#bbb",fontSize:11,fontWeight:700,borderRadius:2,border:i>=3?"1px solid #2A2A30":"none",flexShrink:0}}>{i+1}</div>
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{fontSize:13,fontWeight:700,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{e.driver.flag} {e.driver.name}</div>
                      <div style={{fontSize:11,color:e.team.color}}>{e.team.name}</div>
                    </div>
                    <div style={{textAlign:"right",flexShrink:0}}>
                      <div style={{fontSize:12,fontFamily:"monospace",color:i===0?"#FFC906":"#aaa"}}>{i===0?"POLE":gap?"+"+gap.toFixed(3)+"s":""}</div>
                      {elim&&<div style={{fontSize:10,color:"#FF4444",fontWeight:700}}>ELIM</div>}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
      {/* SPRINT */}
      {detailTab==="sprint"&&snap.sprint&&(
        <div>
          <div style={{fontSize:11,color:"#FFC906",letterSpacing:2,marginBottom:8,fontWeight:700}}>âš¡ SPRINT â€” {snap.sprint.sprintLaps} LAPS</div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:5}}>
            {(()=>{const _ss=new Set();return snap.sprint.positions.filter(e=>{if(_ss.has(e.driverId)) return false;_ss.add(e.driverId);return true;}).slice(0,22);})().map((e,i)=>(
              <div key={e.driverId||i} style={{display:"flex",alignItems:"center",gap:9,padding:"8px 11px",background:e.dnf?"#1A1010":i<3?"#181810":"#161618",border:`1px solid ${e.dnf?"#FF444418":i<3?"#FFC90618":"#1E1E22"}`,borderLeft:`3px solid ${e.dnf?"#FF4444":e.teamColor}`,borderRadius:3,opacity:e.dnf?0.65:1}}>
                <div style={{width:26,height:26,display:"flex",alignItems:"center",justifyContent:"center",background:i===0?"#FFC906":i===1?"#aaa":i===2?"#CD7F32":"transparent",color:i<3?"#000":"#bbb",fontSize:11,fontWeight:700,borderRadius:2,border:i>=3?"1px solid #2A2A30":"none",flexShrink:0}}>{e.dnf?"DNF":i+1}</div>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontSize:13,fontWeight:700,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{e.driverFlag} {e.driverName}</div>
                  <div style={{fontSize:11,color:e.teamColor}}>{e.teamName}</div>
                </div>
                <div style={{textAlign:"right",flexShrink:0}}>
                  {e.dnf?<div style={{fontSize:11,color:"#FF4444"}}>L{e.dnfLap}</div>
                        :<><div style={{fontSize:12,fontFamily:"monospace",color:i===0?"#FFC906":"#bbb"}}>{i===0?"WIN":`+${e.gap}s`}</div>{e.points>0&&<div style={{fontSize:11,color:"#FFC906",fontWeight:700}}>+{e.points}pts</div>}</>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function EditModal({type,data,teams,drivers,onSave,onClose,teamBudgets,currentRound,onSetBudget}){
  const [f,setF]=useState({...data,goodTracks:data.goodTracks||[],badTracks:data.badTracks||[],mental:data.mental||7,rivals:data.rivals||[]});
  const isD=type==="driver";
  const sf=isD?[["pace","Raw Pace"],["consistency","Consistency"],["wet","Wet Weather"],["overtaking","Overtaking"],["defense","Defense"],["experience","Experience"]]:[]/*PARTS_UI*/;
  const inp={background:"#1E1E22",border:"1px solid #333",color:"#F0F0F0",padding:"9px 12px",width:"100%",fontFamily:"inherit",fontSize:16,borderRadius:3};
  return(
    <div onClick={e=>e.target===e.currentTarget&&onClose()} style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.9)",zIndex:9999,display:"flex",alignItems:"center",justifyContent:"center"}}>
      <div style={{background:"#161618",border:"1px solid #2A2A30",borderRadius:8,padding:24,width:460,maxHeight:"88vh",overflowY:"auto"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:18}}>
          <div>
            <span style={{fontSize:16,fontWeight:700,letterSpacing:2.5,color:"#E8002D"}}>{isD?"EDIT DRIVER":"EDIT TEAM"}</span>
            {!isD&&(()=>{
              const teamObj=teams.find(t=>t.id===data.id)||data;
              const tier=TIER_CONFIG[teamObj.tier||"low"]||TIER_CONFIG.low;
              const cap=(teamBudgets&&teamBudgets[data.id])||tier.startCap;
              return(
                <div style={{display:"flex",gap:8,alignItems:"center",marginTop:5}}>
                  <span style={{fontSize:10,fontWeight:700,letterSpacing:1.5,color:tier.color,background:tier.color+"18",padding:"2px 7px",borderRadius:2}}>{tier.label}</span>
                  <span style={{fontSize:12,color:"#aaa",display:"flex",alignItems:"center",gap:4}}>
                    Budget cap: £<input
                      type="number" min={1} max={999} value={cap}
                      onChange={e=>{const v=parseInt(e.target.value)||1;if(onSetBudget)onSetBudget(data.id,v);}}
                      style={{width:52,background:"#111115",border:"1px solid #FFC90644",borderRadius:3,color:"#FFC906",fontWeight:700,fontSize:13,padding:"1px 5px",fontFamily:"inherit",textAlign:"center"}}
                    />m
                  </span>
                </div>
              );
            })()}
          </div>
          <button onClick={onClose} style={{background:"none",border:"none",color:"#aaa",cursor:"pointer",fontSize:26}}>Ã—</button>
        </div>
        {isD?(
          <>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:14}}>
              {[["Full Name","name","text"],["Abbreviation","abbr","text"],["Number","num","number"],["Flag","flag","text"]].map(([l,k,tp])=>(
                <div key={k}><div style={{fontSize:13,color:"#aaa",letterSpacing:1.5,marginBottom:4}}>{l.toUpperCase()}</div>
                  <input value={f[k]} type={tp} maxLength={k==="abbr"?3:undefined} onChange={e=>setF(p=>({...p,[k]:tp==="number"?parseInt(e.target.value)||0:k==="abbr"?e.target.value.toUpperCase():e.target.value}))} style={inp}/>
                </div>
              ))}
              <div style={{gridColumn:"span 2"}}><div style={{fontSize:13,color:"#aaa",letterSpacing:1.5,marginBottom:4}}>TEAM</div>
                <select value={f.teamId} onChange={e=>setF(p=>({...p,teamId:e.target.value}))} style={{...inp}}>{teams.map(t=><option key={t.id} value={t.id}>{t.name}</option>)}</select>
              </div>
            </div>
            {/* Driving style selector */}
            <div style={{marginBottom:16,padding:"12px 14px",background:"#111115",borderRadius:5,border:"1px solid #1E1E22"}}>
              <div style={{fontSize:11,color:"#aaa",letterSpacing:1.5,marginBottom:10,fontWeight:700}}>DRIVING STYLE</div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6}}>
                {DRIVING_STYLES.map(s=>{
                  const sel=f.style===s.id;
                  return(
                    <button key={s.id} type="button" onClick={()=>setF(p=>({...p,style:s.id}))}
                      style={{background:sel?`${s.color}1A`:"#161618",border:`1px solid ${sel?s.color+"88":"#2A2A30"}`,borderRadius:4,padding:"9px 10px",cursor:"pointer",textAlign:"left",transition:"all 0.15s"}}>
                      <div style={{display:"flex",alignItems:"center",gap:7,marginBottom:4}}>
                        <span style={{fontSize:14}}>{s.icon}</span>
                        <span style={{fontSize:12,fontWeight:700,color:sel?s.color:"#ccc",letterSpacing:1}}>{s.name.toUpperCase()}</span>
                      </div>
                      <div style={{fontSize:10,color:sel?"#aaa":"#555",lineHeight:1.45}}>{s.effects}</div>
                    </button>
                  );
                })}
              </div>
              {f.style&&(()=>{const sty=DRIVING_STYLES.find(s=>s.id===f.style);return sty?(
                <div style={{marginTop:10,padding:"9px 12px",background:`${sty.color}0F`,border:`1px solid ${sty.color}33`,borderRadius:3}}>
                  <div style={{fontSize:11,color:sty.color,fontWeight:700,marginBottom:3}}>{sty.icon} {sty.name} â€” Style Profile</div>
                  <div style={{fontSize:12,color:"#aaa",lineHeight:1.6}}>{sty.desc}</div>
                </div>
              ):null;})()}
            </div>
            <div style={{marginBottom:14}}>
              <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
                <span style={{fontSize:14,color:"#aaa",letterSpacing:1.5}}>MENTAL STATE</span>
                <span style={{fontSize:16,fontWeight:700,color:f.mental>=8?"#44CC88":f.mental>=6?"#FFC906":"#FF4444",fontFamily:"monospace"}}>{f.mental}/10</span>
              </div>
              <input type="range" min={1} max={10} step={1} value={f.mental} onChange={e=>setF(p=>({...p,mental:parseInt(e.target.value)}))} style={{width:"100%",accentColor:"#44CC88"}}/>
              <div style={{fontSize:12,color:"#778",marginTop:2}}>1=Struggling · 5=Neutral · 10=Peak Focus</div>
            </div>
            <div style={{marginBottom:14,padding:"10px 12px",background:"#111115",borderRadius:4,border:"1px solid #1E1E22"}}>
              <TrackPicker goodTracks={f.goodTracks} badTracks={f.badTracks} onChange={({goodTracks,badTracks})=>setF(p=>({...p,goodTracks,badTracks}))}/>
            </div>
            {/* Rivals selector */}
            <div style={{marginBottom:14,padding:"12px 14px",background:"#111115",borderRadius:4,border:"1px solid #1E1E22"}}>
              <div style={{fontSize:11,color:"#E8002D",fontWeight:700,letterSpacing:1.5,marginBottom:8}}>âš”ï¸ RIVALRIES</div>
              <RivalPicker
                rivals={f.rivals||[]}
                currentDriverId={f.id}
                allDrivers={drivers.filter(d=>d.id!==f.id)}
                onChange={rivals=>setF(p=>({...p,rivals}))}
              />
            </div>
          </>
        ):(
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:14}}>
            {[["Team Name","name","text"],["Abbreviation","abbr","text"],["Engine","engine","text"]].map(([l,k,tp])=>(
              <div key={k}><div style={{fontSize:13,color:"#aaa",letterSpacing:1.5,marginBottom:4}}>{l.toUpperCase()}</div>
                <input value={f[k]} type={tp} maxLength={k==="abbr"?3:undefined} onChange={e=>setF(p=>({...p,[k]:k==="abbr"?e.target.value.toUpperCase():e.target.value}))} style={inp}/>
              </div>
            ))}
            <div><div style={{fontSize:13,color:"#aaa",letterSpacing:1.5,marginBottom:4}}>TEAM COLOUR</div>
              <input type="color" value={f.color} onChange={e=>setF(p=>({...p,color:e.target.value}))} style={{width:"100%",height:36,background:"#1E1E22",border:"1px solid #333",borderRadius:3,cursor:"pointer"}}/>
            </div>
          </div>
        )}
        {/* Strategy selector for both driver and team modals */}
        {!isD&&(
          <div style={{marginBottom:14,padding:"12px 14px",background:"#111115",borderRadius:5,border:"1px solid #1E1E22"}}>
            <div style={{fontSize:11,color:"#aaa",letterSpacing:1.5,marginBottom:10,fontWeight:700}}>RACE STRATEGY</div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:5}}>
              {TEAM_STRATEGIES.map(s=>{
                const sel=f.strategy===s.id;
                return(
                  <button key={s.id} type="button" onClick={()=>setF(p=>({...p,strategy:s.id}))}
                    style={{background:sel?`${s.color}1A`:"#161618",border:`1px solid ${sel?s.color+"88":"#2A2A30"}`,borderRadius:4,padding:"8px 10px",cursor:"pointer",textAlign:"left",transition:"all 0.15s"}}>
                    <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:3}}>
                      <span style={{fontSize:13}}>{s.icon}</span>
                      <span style={{fontSize:11,fontWeight:700,color:sel?s.color:"#ccc",letterSpacing:0.5}}>{s.name.toUpperCase()}</span>
                    </div>
                    <div style={{fontSize:9,color:sel?"#aaa":"#555",lineHeight:1.4}}>{s.effects}</div>
                  </button>
                );
              })}
            </div>
            {f.strategy&&(()=>{const st=TEAM_STRATEGIES.find(s=>s.id===f.strategy);return st?(
              <div style={{marginTop:8,padding:"8px 10px",background:`${st.color}0F`,border:`1px solid ${st.color}33`,borderRadius:3}}>
                <div style={{fontSize:11,color:st.color,fontWeight:700,marginBottom:2}}>{st.icon} {st.name}</div>
                <div style={{fontSize:11,color:"#aaa",lineHeight:1.5}}>{st.desc}</div>
              </div>
            ):null;})()}
          </div>
        )}
        {sf.map(([k,label])=>(
          <div key={k} style={{marginBottom:12}}>
            <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
              <span style={{fontSize:13,color:"#aaa",letterSpacing:1.5}}>{label.toUpperCase()}</span>
              <span style={{fontSize:15,fontWeight:700,color:f[k]>=90?"#E8002D":f[k]>=75?"#FFC906":"#aaa",fontFamily:"monospace"}}>{f[k]}</span>
            </div>
            <input type="range" min={40} max={99} step={1} value={f[k]||70}
              onChange={e=>setF(p=>({...p,[k]:parseInt(e.target.value)}))}
              style={{width:"100%",accentColor:"#E8002D"}}/>
          </div>
        ))}
        {/* Car stats sliders for teams */}
        {!isD&&(()=>{
          const CAR_SLIDERS = [
            {key:"carPace",     label:"CAR PACE",       min:55, max:99,  color:"#E8002D", desc:"Raw car performance â€” affects qualifying and race pace"},
            {key:"reliability", label:"RELIABILITY",    min:55, max:99,  color:"#44CC88", desc:"Mechanical reliability â€” lower = higher DNF risk"},
            {key:"pitSpeed",    label:"PIT SPEED",      min:70, max:99,  color:"#FFC906", desc:"Pit stop execution speed â€” affects undercut/overcut"},
            {key:"tyreLife",    label:"TYRE LIFE",      min:40, max:90,  color:"#4488FF", desc:"Tyre management â€” how long tyres last at race pace"},
            {key:"cornering",   label:"CORNERING",      min:1,  max:20,  color:"#BB66FF", desc:"Corner speed advantage â€” benefits technical circuits"},
            {key:"topSpeed",    label:"TOP SPEED",      min:1,  max:20,  color:"#FF8844", desc:"Straight-line speed â€” benefits power circuits with DRS"},
          ];
          return(
            <div style={{marginBottom:14,padding:"12px 14px",background:"#111115",borderRadius:5,border:"1px solid #1E1E22"}}>
              <div style={{fontSize:11,color:"#4488FF",fontWeight:700,letterSpacing:1.5,marginBottom:14}}>ðŸŽ CAR PERFORMANCE</div>
              {CAR_SLIDERS.map(({key,label,min,max,color,desc})=>{
                const val = f[key]??min;
                const pct = ((val-min)/(max-min))*100;
                return(
                  <div key={key} style={{marginBottom:14}}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4}}>
                      <span style={{fontSize:12,color:"#ccc",letterSpacing:1.5,fontWeight:700}}>{label}</span>
                      <span style={{fontSize:16,fontWeight:900,color,fontFamily:"monospace"}}>{val}</span>
                    </div>
                    <div style={{position:"relative",height:6,background:"#1A1A22",borderRadius:3,marginBottom:4}}>
                      <div style={{position:"absolute",left:0,top:0,height:6,width:`${pct}%`,background:color,borderRadius:3,transition:"width 0.15s"}}/>
                    </div>
                    <input type="range" min={min} max={max} step={1} value={val}
                      onChange={e=>setF(p=>({...p,[key]:parseInt(e.target.value)}))}
                      style={{width:"100%",accentColor:color,marginBottom:2}}/>
                    <div style={{fontSize:10,color:"#556"}}>{desc}</div>
                  </div>
                );
              })}
            </div>
          );
        })()}
        <div style={{display:"flex",gap:10,marginTop:18}}>
          <button onClick={()=>onSave(f)} style={{flex:1,background:"#E8002D",color:"#fff",border:"none",padding:11,cursor:"pointer",fontFamily:"inherit",fontSize:16,fontWeight:700,letterSpacing:2.5,borderRadius:3}}>SAVE</button>
          <button onClick={onClose} style={{background:"transparent",color:"#aaa",border:"1px solid #333",padding:"11px 18px",cursor:"pointer",fontFamily:"inherit",fontSize:15,borderRadius:3}}>CANCEL</button>
        </div>
      </div>
    </div>
  );
}

function QGrid({entries,gapFrom,posLabel,elimLine,elimColor="#FF4444"}){
  return(
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6}}>
      {entries.map((e,i)=>{
        const elim=elimLine!=null&&i>=elimLine;
        const gap=i===0?null:((gapFrom[0].score-e.score)*0.011);
        return(
          <div key={e.driver.id} style={{background:elim?"#1A1010":i<3?"#181810":"#161618",border:`1px solid ${elim?`${elimColor}44`:i<3?"#FFC90622":"#1E1E22"}`,borderLeft:`3px solid ${elim?elimColor:e.team.color}`,borderRadius:3,padding:"11px 14px",display:"flex",alignItems:"center",gap:10,opacity:elim?0.55:1}}>
            <div style={{width:32,height:32,display:"flex",alignItems:"center",justifyContent:"center",background:i===0?"#FFC906":i===1?"#aaa":i===2?"#CD7F32":"transparent",color:i<3?"#000":"#bbb",fontSize:13,fontWeight:700,borderRadius:2,border:i>=3?"1px solid #2A2A30":"none",flexShrink:0}}>{i+1}</div>
            <div style={{flex:1,minWidth:0}}>
              <div style={{fontSize:16,fontWeight:700,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{e.driver.name}</div>
              <div style={{fontSize:13,color:e.team.color,letterSpacing:1.5}}>{e.team.name}</div>
              {e.sectors&&(
                <div style={{display:"flex",gap:5,marginTop:5}}>
                  {e.sectors.map((s,si)=>{
                    const purple=e.sectorPurple&&e.sectorPurple[si];
                    const c=purple?"#CC44FF":SECTOR_COLORS[si];
                    return(
                      <div key={si} style={{display:"flex",alignItems:"center",gap:4,padding:"2px 6px 2px 7px",borderRadius:3,background:`linear-gradient(180deg,${c}2A,${c}14)`,border:`1px solid ${c}66`,boxShadow:purple?`0 0 6px ${c}55`:"none"}}>
                        <span style={{fontSize:9,fontWeight:700,letterSpacing:0.5,color:c}}>S{si+1}</span>
                        <span style={{fontSize:11,fontFamily:"monospace",fontWeight:700,color:"#F0F0F0"}}>{s.toFixed(3)}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
            <div style={{textAlign:"right",flexShrink:0}}>
              <div style={{fontSize:15,fontFamily:"monospace",color:i===0?"#FFC906":"#aaa"}}>{i===0?"POLE":gap?"+"+gap.toFixed(3)+"s":""}</div>
              {elim&&<div style={{fontSize:12,color:elimColor,fontWeight:700}}>ELIMINATED</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// Aggregated qualifying: run N times, average grid positions â†’ canonical grid

// â•‘  When ACCURACY selector is set to Ã—5/Ã—10/Ã—20, these functions run the  â•‘
// â•‘  random variance. The canonical result is the most probable outcome.    â•‘
// â•‘  aggQual()   â€” Average qualifying grid from N runs                      â•‘
// â•‘  aggSprint() â€” Average sprint positions from N runs                     â•‘
// Aggregated qualifying: run N times, average scores â†’ canonical grid.
// Session display (q1/q2/q3 tabs) uses a representative single run so each
// session shows its own varied order rather than the same averaged ranking.
function aggQual(n, drivers, teams, track) {
  if(n<=1) {
    const r = runQ1Q2Q3(drivers,teams,track);
    const ref = refLapSeconds(track);
    return {...r, q1:annotateSectorTimes(r.q1,track,ref), q2:annotateSectorTimes(r.q2,track,ref), q3:annotateSectorTimes(r.q3,track,ref)};
  }
  const q1ScoreAcc={}, q2ScoreAcc={}, q3ScoreAcc={};
  drivers.forEach(d=>{ q1ScoreAcc[d.id]=[]; q2ScoreAcc[d.id]=[]; q3ScoreAcc[d.id]=[]; });
  let displayRun=null;
  for(let i=0;i<n;i++){
    const q=runQ1Q2Q3(drivers,teams,track);
    if(i===Math.floor(n/2)) displayRun=q;
    q.q1.forEach(e=>q1ScoreAcc[e.driver.id].push(e.score));
    q.q2.forEach(e=>q2ScoreAcc[e.driver.id].push(e.score));
    q.q3.forEach(e=>q3ScoreAcc[e.driver.id].push(e.score));
  }
  const avg=arr=>arr.length?arr.reduce((a,b)=>a+b,0)/arr.length:null;
  const driverMap=drivers.map(d=>{
    const team=teams.find(t=>t.id===d.teamId)||teams[teams.length-1];
    return {driver:d, team, q1Score:avg(q1ScoreAcc[d.id])||0, q2Score:avg(q2ScoreAcc[d.id]), q3Score:avg(q3ScoreAcc[d.id])};
  });
  const q1Avg=[...driverMap].sort((a,b)=>b.q1Score-a.q1Score).map((e,i)=>({...e, score:e.q1Score, q1Pos:i+1, elim1:i>=15}));
  const q2All=[...driverMap].map(e=>({...e, score:e.q2Score!==null?e.q2Score:e.q1Score-3})).sort((a,b)=>b.score-a.score);
  const q2Avg=[...q2All.slice(0,15).map((e,i)=>({...e, q2Pos:i+1, elim2:i>=10})),...q2All.slice(15).map((e,i)=>({...e, q2Pos:16+i, elim2:true}))];
  const q3All=[...driverMap].map(e=>({...e, score:e.q3Score!==null?e.q3Score:(e.q2Score!==null?e.q2Score-2:e.q1Score-5)})).sort((a,b)=>b.score-a.score);
  const q3Avg=q3All.slice(0,10).map((e,i)=>({...e, q3Pos:i+1}));
  const q2Elim=q2Avg.filter(e=>e.elim2).sort((a,b)=>a.q2Pos-b.q2Pos);
  const q1Elim=q1Avg.filter(e=>e.elim1).sort((a,b)=>a.q1Pos-b.q1Pos);
  // Deduplicate by driver id (independent sorts can place same driver in multiple groups)
  const gridSeen=new Set();
  const grid=[...q3Avg,...q2Elim,...q1Elim].filter(e=>{
    if(gridSeen.has(e.driver.id)) return false;
    gridSeen.add(e.driver.id);
    return true;
  });
  // Safety net: a driver in q2All top-10 but outside q3All top-10 and outside q1Elim
  // falls through all three sets â€” append them at the back sorted by q1Score
  driverMap.filter(e=>!gridSeen.has(e.driver.id))
    .sort((a,b)=>b.q1Score-a.q1Score)
    .forEach(e=>{grid.push({...e,score:e.q1Score});gridSeen.add(e.driver.id);});
  const avgElim1=new Set(q1Elim.map(e=>e.driver.id));
  const avgElim2=new Set(q2Elim.map(e=>e.driver.id));
  const q1Display=displayRun?displayRun.q1.map(e=>({...e, elim1:avgElim1.has(e.driver.id)})):q1Avg;
  const q2Display=displayRun?displayRun.q2.map(e=>({...e, elim2:avgElim2.has(e.driver.id)})):q2Avg;
  const q3Display=displayRun?displayRun.q3:q3Avg;
  const ref=refLapSeconds(track);
  return {q1:annotateSectorTimes(q1Display,track,ref), q2:annotateSectorTimes(q2Display,track,ref), q3:annotateSectorTimes(q3Display,track,ref), grid:grid.map(e=>({...e,score:e.q3Score||e.q2Score||e.q1Score})), runsUsed:n, q1Events:genQEvents("Q1",q1Display,track,15), q2Events:genQEvents("Q2",q2Display,track,10), q3Events:genQEvents("Q3",q3Display,track,null)};
}

// Aggregated race: run N times, average finish positions â†’ canonical race
function aggRace(n, grid, teams, track) {
  if(n<=1) return runRace(grid,teams,track);
  // Run n times to determine consensus weather/SC/FL, but use repRace positions
  // directly so event-driven DNFs, time penalties and crashes are all preserved.
  let wetCount=0, scCount=0, scLapSum=0;
  const flCount={};
  let repRace=null;
  for(let i=0;i<n;i++){
    const r=runRace(grid,teams,track);
    if(i===Math.floor(n/2)) repRace=r;
    if(r.isWet) wetCount++;
    if(r.hasSC){scCount++;scLapSum+=r.scLap;}
    if(r.fastestLap) flCount[r.fastestLap.id]=(flCount[r.fastestLap.id]||0)+1;
  }
  // Use repRace positions as canonical â€” already has correct DNFs, penalties, gaps
  const canon = repRace ? repRace.positions : runRace(grid,teams,track).positions;
  // Deduplicate by driver id (safety net)
  const canonSeen=new Set();
  const dedupCanon=canon.filter(e=>{
    if(canonSeen.has(e.driver.id)) return false;
    canonSeen.add(e.driver.id);
    return true;
  });
  dedupCanon.forEach((e,i)=>{
    e.finalPos=i+1;
    e.points=(!e.dnf&&i<10)?PTS[i]:0;
  });
  const flId=Object.entries(flCount).sort((a,b)=>b[1]-a[1])[0]?.[0];
  const fastestLap=flId?grid.find(e=>e.driver.id===flId)?.driver:null;
  let fastestLapSeconds=null, fastestLapSectors=null;
  if(fastestLap){
    const fe=dedupCanon.find(e=>e.driver.id===fastestLap.id);
    if(fe){
      if(!fe.dnf&&fe.finalPos<=10)fe.points+=1;
      fastestLapSeconds=estimateRaceLapSeconds(track);
      fastestLapSectors=computeSectorTimes(fe, dedupCanon, track, fastestLapSeconds);
    }
  }
  const qw=repRace?repRace.quarterWeather:null;
  return {positions:dedupCanon,events:repRace?repRace.events:[],fastestLap,fastestLapSeconds,fastestLapSectors,isWet:wetCount>=n/2,hasSC:scCount>=n/2,scLap:scCount?Math.round(scLapSum/scCount):0,totalLaps:track.laps,runsUsed:n,quarterStandings:buildQuarterStandings(dedupCanon,track.laps,qw),quarterWeather:qw,dryingLap:repRace?repRace.dryingLap:0,hasRF:repRace?repRace.hasRF:false,rfLap:repRace?repRace.rfLap:0,rfResumeLap:repRace?repRace.rfResumeLap:0};
}

// Aggregated sprint: run N times, average positions â†’ canonical sprint
function aggSprint(n, grid, teams, track) {
  const spSeen=new Set();
  grid=grid.filter(e=>{if(spSeen.has(e.driver.id)) return false;spSeen.add(e.driver.id);return true;}).slice(0,22);
  if(n<=1) return runSprint(grid,teams,track);
  const posAcc={}, dnfCount={}, dnfLaps={}; let spLaps=0;
  grid.forEach(({driver})=>{posAcc[driver.id]=[];dnfCount[driver.id]=0;dnfLaps[driver.id]=[];});
  for(let i=0;i<n;i++){
    const s=runSprint(grid,teams,track);
    spLaps=s.sprintLaps;
    s.positions.forEach((e,idx)=>{
      posAcc[e.driver.id].push(idx+1);
      if(e.dnf){dnfCount[e.driver.id]++;if(e.dnfLap) dnfLaps[e.driver.id].push(e.dnfLap);}
    });
  }
  const avg=arr=>arr.length?arr.reduce((a,b)=>a+b,0)/arr.length:0;
  const canon=grid.map(({driver,team})=>{
    const isDNF=dnfCount[driver.id]/n>=0.5;
    const ap=avg(posAcc[driver.id]);
    return {driver,team,gridPos:grid.findIndex(e=>e.driver.id===driver.id)+1,avgPos:ap,isDNF,dnfLap:isDNF&&dnfLaps[driver.id].length?Math.round(avg(dnfLaps[driver.id])):null};
  }).sort((a,b)=>a.isDNF!==b.isDNF?(a.isDNF?1:-1):a.avgPos-b.avgPos);
  let cg=0;
  canon.forEach((e,i)=>{
    e.finalPos=i+1; e.dnf=e.isDNF;
    e.points=(!e.isDNF&&i<8)?SPRINT_PTS[i]:0;
    if(i===0){e.gap=0;}else if(e.isDNF){e.gap=null;}
    else{cg=parseFloat((cg+Math.max(0.2,(e.avgPos-canon[0].avgPos)*0.5)).toFixed(3));e.gap=cg;}
  });
  return {positions:canon,sprintLaps:spLaps,runsUsed:n};
}


// â•‘  Runs the full weekend pipeline (qual + optional sprint + race) N times â•‘
// â•‘  average position, total points. Powers the ðŸ“Š MULTI-SIM tab.          â•‘
function runMultiSim(n, drivers, teams, track) {
  const acc = {};
  drivers.forEach(d => {
    acc[d.id] = {
      driver: d,
      team: teams.find(t => t.id === d.teamId) || teams[teams.length-1],
      racePos: [], qualPos: [], racePts: [], sprintPts: [],
      wins: 0, podiums: 0, poles: 0, dnfs: 0, sprintWins: 0, fastestLaps: 0,
    };
  });

  for (let i = 0; i < n; i++) {
    const q = runQ1Q2Q3(drivers, teams, track);
    q.grid.forEach((e, idx) => {
      acc[e.driver.id].qualPos.push(idx + 1);
      if (idx === 0) acc[e.driver.id].poles++;
    });

    if (track.hasSprint) {
      const sp = runSprint(q.grid, teams, track);
      sp.positions.forEach((e, idx) => {
        acc[e.driver.id].sprintPts.push(e.points || 0);
        if (idx === 0 && !e.dnf) acc[e.driver.id].sprintWins++;
      });
    }

    const r = runRace(q.grid, teams, track);
    r.positions.forEach((e, idx) => {
      acc[e.driver.id].racePos.push(idx + 1);
      acc[e.driver.id].racePts.push(e.points || 0);
      if (e.dnf) acc[e.driver.id].dnfs++;
      if (idx === 0 && !e.dnf) acc[e.driver.id].wins++;
      if (idx < 3 && !e.dnf) acc[e.driver.id].podiums++;
    });
    if (r.fastestLap) acc[r.fastestLap.id] = acc[r.fastestLap.id] || acc[r.fastestLap.id];
    if (r.fastestLap && acc[r.fastestLap.id]) acc[r.fastestLap.id].fastestLaps++;
  }

  const avg = arr => arr.length ? arr.reduce((a,b) => a+b, 0) / arr.length : 0;
  const best = arr => arr.length ? Math.min(...arr) : 0;
  const worst = arr => arr.length ? Math.max(...arr) : 0;

  return Object.values(acc).map(r => ({
    ...r,
    avgPos:         avg(r.racePos),
    avgQualPos:     avg(r.qualPos),
    avgRacePts:     avg(r.racePts),
    avgSprintPts:   avg(r.sprintPts),
    totalPts:       r.racePts.reduce((a,b)=>a+b,0) + r.sprintPts.reduce((a,b)=>a+b,0),
    bestPos:        best(r.racePos),
    worstPos:       worst(r.racePos),
    winPct:         r.wins / n,
    podiumPct:      r.podiums / n,
    dnfPct:         r.dnfs / n,
    polePct:        r.poles / n,
  })).sort((a, b) => b.totalPts - a.totalPts);
}


// ===================== PRE-SEASON TESTING =====================

const TESTING_SESSIONS = [
  {id:"barcelona_test", name:"Barcelona Pre-Season Test", circuit:"Circuit de Catalunya", flag:"ðŸ‡ªðŸ‡¸", dates:"Feb 10â€“12, 2027", trackId:"spain",  days:3},
  {id:"bahrain_test",   name:"Bahrain Pre-Season Test",  circuit:"Bahrain Int'l Circuit", flag:"ðŸ‡§ðŸ‡­", dates:"Feb 24â€“26, 2027", trackId:"bahrain", days:3},
];


// â•‘  Generates per-day test data: qualifying simulation laps, long-run      â•‘
// â•‘  character (installation / setup / quali sims) with conditions.         â•‘
function runPreseasonTest(days, drivers, teams, trackId) {
  const track = TRACKS.find(t=>t.id===trackId)||TRACKS[0];
  const ISSUE_TYPES = ["Hydraulics issue","Power unit concern","Gearbox problem","Brake failure","Cooling issue","Suspension damage","Oil leak","Electrical fault","DRS fault","Floor damage"];
  const CONDITIONS = [
    {label:"Clear & cool",icon:"ðŸŒ¤ï¸", gripMod:0,   paceMod:0},
    {label:"Overcast",    icon:"â˜ï¸",  gripMod:0.1, paceMod:0.1},
    {label:"Light rain",  icon:"ðŸŒ¦ï¸", gripMod:0.3, paceMod:0.5},
    {label:"Windy",       icon:"ðŸ’¨",  gripMod:0.2, paceMod:0.2},
    {label:"Sunny & hot", icon:"â˜€ï¸",  gripMod:-0.1,paceMod:-0.1},
  ];
  const DAY_CHAR = [
    {label:"Installation laps & baseline runs",   lapsMod:0.55, timeMod:0.8,  qualiRunChance:0.2, longRunChance:0.4},
    {label:"Set-up work & race simulations",       lapsMod:0.85, timeMod:0.35, qualiRunChance:0.5, longRunChance:0.8},
    {label:"Qualifying simulations & final runs",  lapsMod:1.0,  timeMod:0,    qualiRunChance:0.9, longRunChance:0.6},
  ];

  // Build per-driver overall data once, then vary by day
  const driverBases = drivers.map(d=>{
    const team=teams.find(t=>t.id===d.teamId)||teams[teams.length-1];
    const _tts=getTeamStats(team);
    const base=87+(100-_tts.carPace)*0.28+(100-d.pace)*0.14;
    const altPenalty=((track.alt||0)>500?(track.alt-500)/8000:0);
    return {driver:d,team,tts:_tts,base,altPenalty};
  });

  // Generate each day
  const dayData = Array.from({length:days},(_, di)=>{
    const char=DAY_CHAR[Math.min(di,2)];
    const cond=track.wr>40&&Math.random()<0.3?CONDITIONS[2]: // rain more likely on wet-prone tracks
               track.temp>28&&di===1?CONDITIONS[4]:
               CONDITIONS[Math.floor(Math.random()*CONDITIONS.length)];
    const incidents=[];
    const lapTotal={};

    const dayResults=driverBases.map(({driver:d,team,tts:_tts,base,altPenalty})=>{
      // Each day slightly different pace picture â€” teams try different configs
      const setupVar=(Math.random()-0.5)*0.6; // team setup direction that day
      const timeMod=char.timeMod*(Math.random()*0.8+0.6);
      const condMod=cond.paceMod;
      const didQualiRun=Math.random()<char.qualiRunChance;
      const didLongRun =Math.random()<char.longRunChance;

      const bestLap = didQualiRun
        ? parseFloat((base+altPenalty+condMod+setupVar+(Math.random()-0.5)*0.6-timeMod).toFixed(3))
        : parseFloat((base+altPenalty+condMod+setupVar+(Math.random()-0.5)*0.4+0.4).toFixed(3));

      const longRun = didLongRun
        ? parseFloat((base+altPenalty+condMod+setupVar+0.7+(Math.random()-0.5)*0.4+((100-d.consistency)*0.04)).toFixed(3))
        : null;

      const lapsDone = Math.floor((28+Math.random()*30)*char.lapsMod);
      lapTotal[d.id]=lapsDone;

      // Per-day issues â€” more common on day 1
      const issueChance=(100-_tts.reliability)/260*(di===0?1.6:di===1?1.0:0.7);
      const issue=Math.random()<issueChance?{
        type:ISSUE_TYPES[Math.floor(Math.random()*ISSUE_TYPES.length)],
        session:_pick(["Morning","Afternoon"]),
        lapLost:Math.floor(5+Math.random()*20),
        severity:Math.random()<0.3?"Major":Math.random()<0.6?"Minor":"Warning",
      }:null;
      if(issue) incidents.push({driver:d,team,issue});

      return {driver:d,team,bestLap,longRun,laps:lapsDone,issue,didQualiRun,didLongRun};
    }).filter(r=>r.bestLap).sort((a,b)=>a.bestLap-b.bestLap);

    return {
      day:di+1,
      char,
      conditions:cond,
      results:dayResults,
      incidents,
      totalLaps:Object.values(lapTotal).reduce((a,b)=>a+b,0),
    };
  });

  // Build overall summary â€” best lap from any day, total laps
  const overall=driverBases.map(({driver:d,team})=>{
    const allDayResults=dayData.map(dd=>dd.results.find(r=>r.driver.id===d.id)).filter(Boolean);
    const bestLap=Math.min(...allDayResults.map(r=>r.bestLap));
    const longRuns=allDayResults.filter(r=>r.longRun).map(r=>r.longRun);
    const longRun=longRuns.length?parseFloat((longRuns.reduce((a,b)=>a+b,0)/longRuns.length).toFixed(3)):null;
    const totalLaps=allDayResults.reduce((a,r)=>a+r.laps,0);
    const allIssues=dayData.flatMap(dd=>dd.incidents.filter(inc=>inc.driver.id===d.id).map(inc=>({day:dd.day,...inc.issue})));
    return {driver:d,team,qualiSim:bestLap,longRun:longRun||parseFloat((bestLap+0.7+(Math.random()*0.4)).toFixed(3)),laps:totalLaps,issues:allIssues};
  }).sort((a,b)=>a.qualiSim-b.qualiSim);

  return {days:dayData,overall};
}

function fmtLap(s){const m=Math.floor(s/60);return `${m}:${(s%60).toFixed(3).padStart(6,"0")}`;}

// ===================== SESSION CAPTIONS =====================


// â•‘  Sky Sports-style written reports for each session. All randomised      â•‘
// â•‘                                                                          â•‘
// â•‘  buildSprintCaption()     â€” Sprint race report with rivalries            â•‘
// â•‘  buildDayCaption()        â€” Per-day test report                          â•‘
// â•‘  buildQ2Caption()         â€” Q2 session narrative with tyre strategy      â•‘
function buildQualifyingCaption(q1,q2,q3,grid,track){
  const pole=grid[0], p2=grid[1], p3=grid[2], p4=grid[3]||grid[2];
  const q2elim=q1.filter(e=>e.elim1);
  const q3elim=q2.filter(e=>e.elim2);
  const bigElim=q3elim.find(e=>e.q2Pos<=4);
  const bigQ1Elim=q2elim.find(e=>e.q1Pos<=6);
  const surprise=q3.find((e,i)=>i<3&&(e.q2Pos||10)>6);
  const margins=q3[0].score-q3[1].score;
  const tight=margins<1.5, dominant=margins>4.5;
  const poleGap=((q3[0].score-q3[1].score)*0.011).toFixed(3);
  const sameTeam=p2.team.id===pole.team.id;
  const nightStr=track.night?"under the floodlights":"";
  const streetStr=track.street?`the ${track.circuit} street circuit`:`${track.circuit}`;
  const altNote=track.alt>1500?` â€” the thin air at ${track.alt}m altitude flattered the high-downforce setups`:"";
  const tempNote=track.temp>30?` in brutal ${track.temp}°C heat`:(track.temp<12?` in surprisingly cold ${track.temp}°C conditions`:"");

  // --- Sky Sports style intro ---
  const intros=[
    `QUALIFYING REPORT â€” ${track.name.toUpperCase()} ${nightStr?'| NIGHT SESSION':''}\n\n${pole.driver.name} has taken a superb pole position at ${streetStr}${tempNote}, delivering a lap that will live long in the memory. The ${pole.team.name} driver banked it at exactly the right moment${altNote}.`,
    `${track.flag} QUALIFYING RESULT â€” ${track.circuit}\n\n${pole.driver.name} is on pole position for tomorrow's ${track.name}. The ${pole.team.name} driver produced a ${_pick(["scintillating","stunning","finely-crafted"])} lap in Q3${nightStr?" under the floodlights":""} to claim top spot${altNote}${tempNote}.`,
    `IT'S ${pole.driver.name.toUpperCase()} ON POLE AT ${track.circuit.toUpperCase()}!\n\nA ${_pick(["masterclass","statement of intent","brilliant"])} qualifying performance from the ${pole.team.name} driver sealed the top spot. ${poleGap}s was the margin over ${p2.driver.name} â€” in Formula 1 terms, a ${tight?"razor-thin":dominant?"significant":"clear"} advantage${tempNote}.`,
  ];

  // --- Front row / top 3 detail ---
  const frontRows=[
    sameTeam
      ?`${p2.driver.name} completes a stunning ${pole.team.name} 1-2, locking out the entire front row. That is a commanding statement from the ${pole.team.name} garage going into tomorrow.`
      :`${p2.driver.name} lines up alongside on the front row for ${p2.team.name}. The two front-row starters come from different teams, meaning strategy will be the decisive battleground tomorrow. ${p3?`${p3.driver.name} (${p3.team.name}) completes the top three.`:""}`,
    `The front row belongs to ${pole.driver.name} and ${p2.driver.name}, ${p2.team.id===pole.team.id?"both flying the flag for "+pole.team.name:"representing "+pole.team.name+" and "+p2.team.name+" respectively"}. ${p3?`P3 goes to ${p3.driver.name} â€” ${p3.team.name} will fancy their chances of a podium from that grid slot.`:""}`,
  ];

  // --- Margin analysis ---
  const marginAnalysis=tight
    ?[`This was a breathtakingly close Q3. The top ${Math.min(q3.length,6)} drivers were covered by less than a second â€” a gap that can evaporate entirely under a safety car deployment. Any of the top four could realistically win this race.`,
      `Tenths and thousandths decided pole. The data will make fascinating reading back at the factories tonight â€” both teams operating at the absolute ragged edge of their development.`]
    :dominant
    ?[`${pole.driver.name} was simply untouchable. That gap to ${p2.driver.name} is not just a pole position â€” it's a message. ${pole.team.name} arrive at ${track.circuit} with a significant performance advantage, and the rest of the grid will be scrambling to find a strategic answer.`,
      `Dominant. Commanding. Complete. ${pole.driver.name} put in a lap that answered every question about the ${pole.team.name}'s form at this circuit. Unless something dramatic happens at the start, they will be very hard to beat tomorrow.`]
    :[`${poleGap}s is the gap at the front â€” enough to feel the pressure, not so much that the race is decided. ${p2.driver.name} will be watching for an opportunity at the start and studying ${pole.driver.name}'s lines through the first complex.`,
      `${pole.driver.name} holds the advantage, but ${p2.driver.name} will have studied every data point from this session. The duel continues tomorrow, and starting on the clean side of the grid could be decisive.`];

  // --- Drama and challenges ---
  const drama=[];

  // Q2 shock exits
  if(bigElim) drama.push(`The session's most dramatic moment came in Q2: ${bigElim.driver.name} â€” who had looked quick all weekend â€” was eliminated in fifteenth place. The ${bigElim.team.name} team had gambled on track position and the rubber simply wasn't there. Championship implications may follow.`);
  if(bigQ1Elim) drama.push(`A hammer blow for ${bigQ1Elim.team.name}: ${bigQ1Elim.driver.name} failed to advance from Q1, eliminated in a session they had been expected to clear comfortably. Questions will be asked about setup direction after a difficult Friday.`);

  // Surprise top-three
  if(surprise) drama.push(`The surprise of qualifying: ${surprise.driver.name} delivers a career-defining lap to slot into the top three. Starting from P${surprise.q3Pos||3} with the big teams watching, this could be a landmark moment for ${surprise.team.name} at this circuit.`);

  // Track-specific challenges
  if(track.night) drama.push(`The floodlights at ${track.circuit} create a unique challenge â€” shadows over the apexes, changing grip levels as the track surface cools, and the psychological pressure of racing at night. Several drivers reported visibility issues through the high-speed sweepers.`);
  if(track.street) drama.push(`Around the ${track.circuit} street circuit, the walls are unforgiving and millimetres matter. ${_pick([p3,p4])?.driver.name||p2.driver.name} was caught out by a yellow flag on their final flying lap â€” robbed of what could have been a front row start.`);
  if(track.wr>45) drama.push(`Rain forecasts hung over the session all day, forcing teams into a high-stakes gamble: bank a time early, or wait for more rubber and risk the deluge. The weather held, but the tension in the pit lane was palpable from the first moment of Q1.`);
  if((track.alt||0)>1200) drama.push(`At ${track.alt}m above sea level, the thin air at ${track.circuit} fundamentally changes how the cars behave â€” less downforce, longer braking zones, and engines running in a very narrow performance window. Teams who nailed the setup philosophy tonight will have a meaningful strategic advantage.`);
  if((track.abrasive||0)>=7) drama.push(`The notoriously abrasive surface here demands a conservative tyre management strategy. Several teams were seen running harder compounds than expected in Q2 â€” protecting rubber for a longer first stint tomorrow rather than chasing lap time tonight.`);
  if(track.corners&&track.corners>20) drama.push(`With ${track.corners} corners in a single lap, qualifying at ${track.circuit} is a test of absolute precision. Any lock-up, any missed apex, any moment of hesitation â€” and the lap is gone. The survivors of Q3 produced textbook performances under enormous pressure.`);

  // Failure scenarios / what can go wrong tomorrow
  const risks=[
    `WHAT COULD GO WRONG TOMORROW: ${pole.driver.name} leads from pole, but a slow getaway into Turn 1 remains the primary threat â€” ${track.street?"the street circuit walls leave no room for recovery from a poor start":track.corners>15?"the complex first sector punishes overly defensive driving":"first corner positioning will be crucial"}. Weather${track.wr>25?" remains a genuine factor":""} and safety car probability at this circuit is historically high.`,
    `KEY RISKS FOR TOMORROW: The race pace data told a different story to qualifying. ${p2.driver.name}'s long runs were not noticeably slower than ${pole.driver.name}'s â€” suggesting that if tyre degradation sets in, the lead could change hands. A virtual safety car or a poorly timed stop could overturn the entire qualifying order.`,
  ];

  return [
    _pick(intros),
    _pick(frontRows),
    _pick(marginAnalysis),
    ...drama.slice(0,3),
    _pick(risks),
  ].filter(Boolean);
}

function buildSprintCaption(sprint,qual,track){
  const pos=sprint.positions;
  const winner=pos[0], p2=pos[1], p3=pos[2];
  const dnfs=pos.filter(e=>e.dnf);
  const chargers=pos.filter((e,i)=>!e.dnf&&(e.gridPos-1-i)>=3).slice(0,3);
  const defenders=pos.filter((e,i)=>!e.dnf&&i<(e.gridPos||20)-3).slice(0,2);
  const surprise=pos.find((e,i)=>i<3&&(e.gridPos||10)>7);
  const luckless=pos.find((e,i)=>!e.dnf&&i>8&&(e.gridPos-1)<=2);
  const spLaps=sprint.sprintLaps;
  const rivalry=p2?getRivalry(winner.driver,p2.driver):null;
  const teamamateDuel=pos.find((e,i)=>i>0&&e.team?.id===pos[0].team?.id&&i<5);
  const pts8=pos.filter(e=>!e.dnf).slice(0,8).map((e,i)=>`${e.driver.name.split(" ").pop()} +${SPRINT_PTS[i]}pts`).join(" · ");

  const intros=[
    `âš¡ SPRINT RACE â€” ${track.circuit.toUpperCase()} | ${spLaps} LAPS | ${_pick(["FULL ATTACK","NO MARGIN FOR ERROR","EVERY LAP COUNTS"])}\n\n${winner.driver.name} takes the sprint victory for ${winner.team.name}. ${spLaps} laps, no safety car buffer, no tyre conservation mindset â€” just eight points for the win and a pecking order established before the main event. ${winner.driver.name} ${_pick([
      "controlled the race from the front with ruthless efficiency.",
      "survived an aggressive first lap to build a lead that was never seriously threatened.",
      "managed tyre life and pace brilliantly â€” the benchmark for tomorrow's strategy discussions.",
      "converted a perfect start into a lights-to-flag victory â€” the team could not have scripted it better.",
    ])}`,
    `${winner.driver.name.toUpperCase()} WINS THE SPRINT â€” ${track.name.toUpperCase()}\n\n${spLaps} laps of intensity and it is ${winner.driver.name} who pockets eight points. The sprint format offers no hiding places, no strategic options â€” raw pace and racing intelligence decide the outcome, and ${winner.driver.name} had both. ${p2?.driver.name||"P2"} pushed hard in the final laps but ${_pick(["could never find a way through","the gap was just too large to close","the DRS didn't deliver the attack needed","the tyre delta told the wrong story"])}.`,
    `SPRINT RESULT: ${winner.driver.name} · ${p2?.driver.name||"P2"} · ${p3?.driver.name||"P3"}\n\nPoints scored: ${pts8}\n\n${winner.driver.name} builds their sprint-weekend record with another maximum haul. The ${winner.team.name} garage celebrates, but the real debrief starts immediately â€” tomorrow is what the points champions are built from.`,
  ];

  const drama=[];

  // Chaotic start
  if(Math.random()<0.55) {
    const chaosDriver=_pick(pos.slice(0,8));
    drama.push(`LAP 1 CHAOS: ${_pick([
      `${chaosDriver.driver.name} gets an incredible getaway from P${chaosDriver.gridPos} and slots into the top five before the first corner.`,
      `Contact at Turn 1 â€” ${chaosDriver.driver.name} (${chaosDriver.team.name}) gets squeezed to the outside and loses three positions in an instant. The sprint is effectively over for them.`,
      `Drama at the start: ${chaosDriver.driver.name} and ${_pick(pos.filter(e=>e.driver.id!==chaosDriver.driver.id).slice(0,6)).driver.name} wheel-to-wheel from the lights â€” ${_pick(["neither gives an inch","${chaosDriver.driver.name} backs out at the last moment","they touch â€” both cars continue but there is damage"])}. The sprint is on.`,
    ])}`);
  }

  // Charger story
  if(chargers.length>0) {
    const c=chargers[0];
    const finalPos=pos.findIndex(e=>e.driver.id===c.driver.id)+1;
    drama.push(`THE DRIVE: ${c.driver.name} was the story inside the story. Starting P${c.gridPos}, the ${c.team.name} driver ${_pick([
      `carved through traffic with the precision of a surgeon and the aggression of a champion.`,
      `found gaps that simply did not exist â€” three overtakes in four laps, including a stunning move around the outside.`,
      `demonstrated exactly why their driving style earns that description: ${_pick(["relentless","electric","unstoppable"])} from lights to chequered flag.`,
      `showed what this machine can do when all the stars align. P${finalPos} from P${c.gridPos} is a remarkable result.`,
    ])} Finishing P${finalPos} from P${c.gridPos} â€” the data will show it was earned.`);
  }

  // Defender story
  if(defenders.length>0) {
    const d=defenders[0];
    const startPos=pos.findIndex(e=>e.driver.id===d.driver.id)+1;
    drama.push(`THE DEFENCE: ${d.driver.name} fought tooth and nail to hold position for ${_pick(["eight","ten","six","twelve"])} consecutive laps â€” mirrors full of pressure, DRS attacks rebuffed, ${_pick([
      "every brake point a battle.",
      "using every millimetre of the track to close the door.",
      "the ${d.team.name} pit wall screaming delta times.",
      "the kind of racecraft that wins championships when it matters.",
    ])} Starting P${d.gridPos}, finishing P${startPos} â€” the ${d.team.name} points banker of the day.`);
  }

  // Rivalry moment
  if(rivalry) {
    drama.push(`${rivalry.desc.charAt(0).toUpperCase()+rivalry.desc.slice(1)} â€” ${winner.driver.name} extends their sprint advantage over ${p2?.driver.name||"P2"} but the margin was ${_pick(["tighter than the gap suggests","earned rather than given","hard-fought through every sector"])}.  Tomorrow's race means everything. The sprint is the prologue.`);
  }

  // Team-mate tension
  if(teamamateDuel) {
    drama.push(`${winner.driver.name} and team-mate ${teamamateDuel.driver.name} (P${pos.findIndex(e=>e.driver.id===teamamateDuel.driver.id)+1}) â€” the internal ${winner.team.name} championship is being contested as hard as the external one. ${_pick([
      "Radio silence between the two sides of the garage, but the data tells its own story.",
      "The team were clear: no team orders in the sprint. Both drivers raced it as such.",
      "The faster ${winner.driver.name} was today. Tomorrow it could flip.",
    ])}`,);
  }

  // Shock results
  if(surprise) {
    drama.push(`${surprise.driver.name} â€” the sprint's surprise package. ${_pick([
      "Started P"+surprise.gridPos+" and finished on the podium through a combination of pace, strategy, and sheer will.",
      "A result that changes their season narrative entirely.",
      "The ${surprise.team.name} debrief tonight will be filled with optimism. They found something this weekend.",
      "Nobody in the paddock predicted this result. The car and driver delivered when nobody was watching.",
    ])}`);
  }

  // DNF consequences
  if(dnfs.length) {
    const dNames=dnfs.map(e=>e.driver.name).join(" and ");
    drama.push(`RETIREMENTS: ${dNames} â€” ${_pick([
      `${dnfs.length===1?"their weekend":"the weekends of both drivers"} take a significant turn for the worse.`,
      `points left on the table that could prove decisive when the championship enters its final rounds.`,
      `the incidents will be reviewed: were they racing accidents or avoidable?`,
      `${dnfs[0].team.name} now ${_pick(["face a damage limitation exercise for tomorrow","will need a miracle in the race","must rebuild morale in the garage quickly"])}`,
    ])}`);
  }

  // Tomorrow preview
  const previews=[
    `TOMORROW: ${winner.driver.name} will start the grand prix from their qualifying position â€” P${qual.grid.findIndex(e=>e.driver.id===winner.driver.id)+1} on the grid, not P1. The sprint hierarchy does not carry over. Every advantage earned today in data â€” tyre wear patterns, engine temperature profiles, overtaking reference points â€” is the real currency heading into Sunday.`,
    `GRAND PRIX PREVIEW: The ${spLaps}-lap sprint was the opening statement. The race is the full argument. ${qual.grid[0]?.driver.name} starts from pole tomorrow â€” the sprint winner, if different, will need to fight through traffic. Strategy will differentiate. Nerves will be tested. Everything starts again in less than twenty-four hours.`,
    `THE REAL RACE TOMORROW: Eight points were distributed today. Twenty-five sit on the table for Sunday. ${_pick([
      `${pos.filter(e=>!e.dnf).slice(0,3).map(e=>e.driver.name).join(", ")} will all believe they can win it.`,
      `The sprint has given teams crucial data about ${track.abrasive>6?"tyre degradation on this abrasive surface":"race pace over representative stints"}.`,
      `Today answered some questions. Tomorrow will answer the ones that matter.`,
    ])}`,
  ];

  return [_pick(intros), ...drama.slice(0,4), _pick(previews)].filter(Boolean);
}

function buildTestingCaption(results, session){
  // overall results use qualiSim; normalise to bestLap for consistent access
  const norm = results.map(r=>({...r, bestLap: r.bestLap||r.qualiSim}));
  const fastest=norm[0], second=norm[1], third=norm[2];
  const topTeam=fastest.team;
  const issues=norm.filter(r=>r.issues&&r.issues.length>0);
  const highMileage=norm.filter(r=>r.laps>110).slice(0,3);
  const lowMileage=results.filter(r=>r.laps<60).slice(0,2);
  const longRunLeader=results.slice().sort((a,b)=>a.longRun-b.longRun)[0];
  const qualiLeader=fastest;
  const longRunSurprise=longRunLeader.driver.id!==qualiLeader.driver.id;

  const intros=[
    `ðŸ”¬ ${session.name.toUpperCase()} â€” DAY ${session.days} REPORT\n\n${session.circuit}, ${session.dates}\n\n${topTeam.name} set the fastest time of the ${session.days}-day test as ${fastest.driver.name} clocked a ${fmtLap(fastest.bestLap)} to go quickest. But as every engineer in the paddock will tell you, February lap times are a story told in pencil â€” the real answers are hidden in the long-run data.`,
    `ðŸ“‹ PRE-SEASON TEST SUMMARY â€” ${session.circuit.toUpperCase()}\n\n${fastest.driver.name} topped the timesheets for ${topTeam.name} with a ${fmtLap(fastest.bestLap)}, but qualifying simulations on fresh tyres represent only one dimension of a complex, data-rich test. The ${session.days} days at ${session.circuit} have raised as many questions as they have answered â€” and that is exactly how the teams want it.`,
  ];

  const pace=[
    `PERFORMANCE PICTURE: ${second.driver.name} (${fmtLap(second.bestLap)}) and ${third.driver.name} (${fmtLap(third.bestLap)}) completed the top three. ${longRunSurprise?`However, ${longRunLeader.driver.name}'s long-run data told a very different story â€” their ${fmtLap(longRunLeader.longRun)} race simulation pace was the strongest in the field, raising questions about fuel loads and engine mapping during the quicker runs.`:`${fastest.driver.name} backed up the fastest lap with the strongest race pace too â€” ${topTeam.name} look genuinely formidable heading into the season opener.`}`,
    `The top three on outright lap time were ${fastest.driver.name}, ${second.driver.name} and ${third.driver.name} â€” but experienced engineers treat qualifying simulations in testing with significant scepticism. Fuel loads, tyre condition and cooling configurations vary wildly between runs, making direct comparisons misleading.`,
  ];

  const mileage=highMileage.length>0
    ?[`MILEAGE LEADERS: ${highMileage.map(r=>`${r.driver.name} (${r.laps} laps, ${r.team.name})`).join(", ")} accumulated the most running. Reliability data at this scale gives the engineers extremely high-quality degradation and wear models â€” an advantage that will pay dividends in the opening races.`]
    :[];

  const techDrama=[];
  if(issues.length>0){
    issues.slice(0,3).forEach(r=>{
      r.issues.forEach(iss=>{
        techDrama.push(`TECHNICAL ISSUE â€” ${r.team.name}: ${r.driver.name} was sidelined on Day ${iss.day} with a ${iss.type}. ${_pick(["The team managed to return to the track later in the session, but lost valuable running time.","Mechanics worked through the night to resolve the issue â€” the number of laps lost will concern the engineering team.","The root cause has been identified and the fix is straightforward, according to the team â€” but a component failure this early is never welcome news."])}`);
      });
    });
  }

  const analysis=[
    `ANALYST'S VIEW: ${_pick([
      `The ${topTeam.name} package looks balanced and fast. ${fastest.driver.name} was consistently at the sharp end and appeared comfortable with the car's behaviour in both high and low fuel configurations.`,
      `${results[Math.floor(results.length/4)].team.name} were quietly impressive throughout the test â€” their long runs were understated but the pace was there in the data. Don't be surprised if they are in the mix at the opening round.`,
      `The midfield picture remains unclear, which is exactly as the teams intended. ${results[Math.floor(results.length/2)].driver.name} turned heads with their consistency on long runs â€” ${results[Math.floor(results.length/2)].team.name} may have found something with this car.`,
    ])}`,
  ];

  const outlook=session.trackId==="spain"
    ?[`BARCELONA CONTEXT: The Circuit de Catalunya's characteristics â€” high tyre degradation, strong lateral loads and sensitivity to aerodynamic efficiency â€” make it a strong baseline for setup development. However, the February ambient temperatures (significantly cooler than race conditions) mean teams apply temperature correction factors to all data points. The real-world performance picture will only fully emerge at the Bahrain test.`]
    :session.trackId==="bahrain"
    ?[`BAHRAIN CONTEXT: This is the test that matters. The Bahrain International Circuit is the opening round of the 2027 season, run under floodlights with the exact ambient conditions teams will face in anger just weeks later. The data gathered here is the most race-representative of the winter. Any team that showed genuine race pace here â€” not just outright lap time â€” has reason for optimism. The 2027 season is almost upon us.`]
    :[];

  return [
    _pick(intros),
    _pick(pace),
    ...mileage,
    ...techDrama.slice(0,2),
    ...analysis,
    ...outlook,
  ].filter(Boolean);
}

function buildDayCaption(dayObj, session, dayIndex, totalDays) {
  const {day, char, conditions, results, incidents, totalLaps} = dayObj;
  const fastest  = results[0];
  const second   = results[1];
  const third    = results[2];
  const isFinal  = day === totalDays;
  const isFirst  = day === 1;
  const gap      = second ? (second.bestLap - fastest.bestLap).toFixed(3) : null;
  const longRunLeader = results.filter(r=>r.longRun).sort((a,b)=>a.longRun-b.longRun)[0];
  const longRunSurprise = longRunLeader && longRunLeader.driver.id !== fastest.driver.id;
  const majorIssues = incidents.filter(i=>i.issue.severity==="Major");
  const minorIssues = incidents.filter(i=>i.issue.severity!=="Major");
  const highLaps = results.filter(r=>r.laps>=40).slice(0,3);
  const didntRunLong = results.filter(r=>r.laps<20);
  const surpriseP = results.find((r,i)=>i<3 && r.didQualiRun && (results.indexOf(r)+4) < results.length);

  // Opening
  const openings = isFirst ? [
    `ðŸ”¬ DAY 1 OF ${totalDays} â€” ${session.circuit.toUpperCase()} | ${conditions.icon} ${conditions.label}\n\nThe pit lane gates open, the engines fire, and the 2027 Formula 1 pre-season begins. Day one is never about lap times â€” it is about systems checks, installation laps and the first tentative feel of a new car on a new circuit. And yet, ${fastest.team.name} could not resist: ${fastest.driver.name} went quickest with a ${fmtLap(fastest.bestLap)}, setting the early benchmark${conditions.paceMod>0?" despite the compromised conditions":""}. A ${totalLaps}-lap day for the field as a whole.`,
    `DAY ONE | ${session.name.toUpperCase()}\n\n${conditions.icon} Conditions: ${conditions.label}. ${fastest.driver.name} (${fastest.team.name}) tops the timing screens on Day 1 with a ${fmtLap(fastest.bestLap)}, though context is everything â€” fuel loads are unknown, tyre specifications vary wildly, and half the field spent the morning on installation laps and aero mapping runs. The real data is in the long-run simulations happening off-camera.`,
  ] : isFinal ? [
    `ðŸ DAY ${day} â€” FINAL DAY | ${session.circuit.toUpperCase()} | ${conditions.icon} ${conditions.label}\n\nThe last day of the ${totalDays}-day test and the pressure is on. This is when engineers want qualifying simulations â€” representative tyres, low fuel, the cars at their competitive best. ${fastest.driver.name} responded emphatically: ${fmtLap(fastest.bestLap)}, ${gap?`${gap}s clear of ${second?.driver.name||"P2"}`:""} â€” a statement time to carry into the season opener. The 2027 championship is almost upon us.`,
    `FINAL DAY SUMMARY â€” ${session.circuit.toUpperCase()}\n\n${conditions.icon} ${conditions.label}. Day ${day} of ${totalDays} and the paddock is buzzing â€” qualifying simulations, race simulations, late aero tests and final reliability checks. When the chequered flag drops on testing, ${fastest.driver.name} leads the overall timesheets with ${fmtLap(fastest.bestLap)}. Whether that represents genuine pace or a low-fuel, fresh-tyre gamble will be debated until the lights go out in ${session.trackId === "spain" ? "Bahrain" : "Melbourne"}.`,
  ] : [
    `ðŸ“‹ DAY ${day} OF ${totalDays} | ${session.circuit.toUpperCase()} | ${conditions.icon} ${conditions.label}\n\nThe midpoint of the ${totalDays}-day test, and the laptimes are beginning to sharpen. ${fastest.driver.name} led the timesheets with ${fmtLap(fastest.bestLap)}${conditions.paceMod>0?" â€” impressive given the conditions":""}. More importantly, the long-run data is building. Race simulations are beginning in earnest, and the true pecking order is slowly revealing itself to those with access to the timing data.`,
    `DAY ${day} REPORT | ${session.circuit}\n\n${conditions.icon} ${conditions.label}. A ${totalLaps}-lap day across the field â€” and the running is picking up. ${fastest.team.name} looked strongest today: ${fastest.driver.name} set a ${fmtLap(fastest.bestLap)} on what appeared to be a low-fuel qualifying run in the ${_pick(["morning","afternoon","final hour of the session"])}. ${second?.driver.name||"P2"} and ${third?.driver.name||"P3"} were not far away.`,
  ];

  // Pace analysis
  const paceAnalysis = [
    longRunSurprise
      ? `PACE PICTURE: The timing screens told one story; the fuel-adjusted data tells another. ${longRunLeader.driver.name} produced the most consistent long-run numbers of the day â€” ${fmtLap(longRunLeader.longRun)} average over an extended stint. That is the figure that will be circled in red in rival garages tonight. ${fastest.driver.name}'s quick time was on a ${_pick(["fresh set of softs","low-fuel single lap","clear track at the end of the session"])} â€” the race pace picture is more complex.`
      : `PACE PICTURE: ${fastest.driver.name} led both the qualifying simulation and long-run charts today. Back-to-back sessions on different fuel loads and it was consistently ${fastest.team.name} at the front. The data correlation from the ${conditions.label.toLowerCase()} conditions will need careful interpretation, but the headline is clear.`,
    `The gap between ${fastest.driver.name} and ${second?.driver.name||"P2"} was ${gap?gap+"s":"marginal"} on outright pace${conditions.paceMod>0?", though the "+conditions.label.toLowerCase()+" conditions make direct comparison difficult":""}.${longRunSurprise?" On long runs, ${longRunLeader.driver.name} looked a different proposition entirely.":""}`,
  ];

  // Technical incidents
  const techLines = [];
  if (majorIssues.length > 0) {
    majorIssues.forEach(inc => {
      techLines.push(`âš ï¸ TECHNICAL STOPPAGE â€” ${inc.team.name}: ${inc.driver.name} was halted by a ${inc.issue.type} during the ${inc.issue.session.toLowerCase()} session, losing an estimated ${inc.issue.lapLost} laps of running. The team have identified the root cause and are working on a resolution overnight. Major interruptions this early in testing are a concern â€” reliability data at this stage is as important as lap time.`);
    });
  }
  if (minorIssues.length > 0 && techLines.length < 2) {
    const mi = minorIssues[0];
    techLines.push(`MINOR ISSUE â€” ${mi.team.name}: ${mi.driver.name} reported a ${mi.issue.type} (${mi.issue.session.toLowerCase()}) but returned to the track after a brief stop. ${mi.issue.lapLost} laps lost â€” frustrating but not catastrophic. The team will review the data overnight.`);
  }
  if (incidents.length === 0) {
    techLines.push(`A clean day in terms of reliability â€” ${totalLaps} laps completed across the field with no significant stoppages. ${fastest.team.name}'s mechanics can allow themselves a cautious smile. Building confidence in the package is as valuable as any lap time.`);
  }

  // Mileage / storylines
  const storyLines = [];
  if (highLaps.length > 0) {
    storyLines.push(`MILEAGE LEADERS: ${highLaps.map(r=>`${r.driver.name} (${r.laps} laps)`).join(", ")} accumulated the most running today. ${highLaps[0].driver.name} in particular was relentless â€” long stints, back-to-back sets, different compounds. The tyre wear data they are generating will be invaluable come race day.`);
  }
  if (surpriseP && !isFirst) {
    storyLines.push(`THE TALKING POINT: ${surpriseP.driver.name} was the name on everyone's lips in the paddock. A genuine qualifying simulation lap elevated them to P${results.indexOf(surpriseP)+1} â€” ${_pick(["a result that surprised even their own engineers","a time that will be studied by rivals in detail","raising questions about whether it was representative or something more significant"])}. Watch this space.`);
  }

  // Day-end look ahead
  const lookAheads = isFinal ? [
    `With testing concluded, the teams pack up and prepare for ${session.trackId==="spain"?"the second test in Bahrain":"the season opener"}. The laptimes will dominate discussion â€” but as every experienced engineer will say, the real work happens in the data warehouse, not on the timing screens.`,
  ] : isFirst ? [
    `Looking ahead to Day ${day+1}: teams will begin race simulations in earnest. The setup baseline from today's runs gives engineers the foundation they need. Expect more representative pace tomorrow â€” and potentially some genuine surprises.`,
    `Day ${day+1} will see teams shift focus: from system validation to performance development. The overnight data crunching will produce a long list of setup changes. The circuit should rubber-in further overnight, and lap times will drop accordingly.`,
  ] : [
    `Final day tomorrow: qualifying simulations, final race runs and the last chance to assess the competition. The paddock will be watching closely â€” every tenth matters when the season is days away.`,
    `One day remaining. Teams will be balancing the temptation to show their hand with the need for representative data. Expect strategic sandbagging and at least one genuine benchmark lap that will set the winter's pecking order.`,
  ];

  return [
    _pick(openings),
    _pick(paceAnalysis),
    ...techLines.slice(0, 2),
    ...storyLines.slice(0, 1),
    _pick(lookAheads),
  ].filter(Boolean);
}


function buildQ1Caption(q1, track){
  const sorted=[...q1].sort((a,b)=>b.score-a.score);
  const elim=q1.filter(e=>e.elim1).sort((a,b)=>b.q1Pos-a.q1Pos);
  const fastest=sorted[0], second=sorted[1];
  const bigBump=elim.find(e=>e.q1Pos<=8);
  const darkHorse=sorted.find((e,i)=>i<5&&(q1.indexOf(e)>10||q1.indexOf(e)>8));
  const tight=(sorted[14]?.score-sorted[15]?.score)<0.6;
  const gap=sorted[1]?((sorted[0].score-sorted[1].score)*0.011).toFixed(3):"0.000";

  const intros=[
    `Q1 â€” ${track.circuit.toUpperCase()} | 18 MINUTES, 20 DRIVERS, FIVE WILL NOT SURVIVE\n\n${fastest.driver.name} led ${fastest.team.name} at the top of Q1 with a commanding ${_pick(["first run banker","mid-session flyer","late improvement run"])}. The ${track.street?"unforgiving walls":"circuit"} claimed its usual victims in the lower half of the order, but the headline is the gap to ${second?.driver.name||"P2"} â€” ${gap}s â€” which may or may not represent a genuine performance advantage.`,
    `Q1 REPORT â€” ${track.name.toUpperCase()}\n\n${fastest.driver.name} goes fastest in Q1 at ${track.circuit}. But this is survival qualifying â€” the task is not to be quickest, it is to be in the top fifteen. The real drama plays out in the elimination zone, where fortunes can turn on a single mistake.`,
    `FIRST BLOOD â€” ${fastest.driver.name} (${fastest.team.name}) tops Q1 at ${track.circuit}. ${_pick([
      "A clean session for the championship leader â€” exactly what was needed.",
      "A session managed perfectly by the team â€” neither showing everything nor risking anything.",
      "Fastest but by no means untouchable â€” the tyre data from this run will be picked apart by rivals tonight.",
    ])}`,
  ];

  const drama=[];
  if(bigBump) drama.push(`THE SHOCK: ${bigBump.driver.name} fails to advance. It is the qualifying story of the weekend â€” a driver in form, a car that has been quick in practice, and yet here they are: eliminated in Q1. ${_pick([
    `The ${bigBump.team.name} team will review every corner of every lap tonight.`,
    `The championship implications are significant. ${bigBump.driver.name} needed points from this race.`,
    `Questions will be asked about tyres, traffic, and whether the setup direction from Friday was simply wrong.`,
  ])}`);
  if(tight) drama.push(`The cut between P15 and P16 was ${_pick(["clinical","brutal","unforgiving"])} â€” ${_pick([
    "thousandths, not tenths, was the difference between a race and an early Sunday.",
    "the driver who survived will celebrate that lap for the rest of the weekend.",
    "both drivers gave absolutely everything. One will contest Q2. One will not.",
    "the kind of margin that keeps engineers staring at data at three in the morning.",
  ])}`);
  if(darkHorse) drama.push(`Worth watching: ${darkHorse.driver.name} (${darkHorse.team.name}) made Q2 look comfortable. Their sector times through ${track.type==="technical"?"the technical middle sector":"the high-speed section"} were a match for cars from supposedly faster teams. Something is working this weekend.`);
  drama.push(`The five eliminated: ${elim.map(e=>e.driver.name).join(", ")}. ${_pick([
    "Each with their own story of a session undone.",
    "All five will study the data and find the tenths that cost them. Too late for this race.",
    "The gap between them and safety ranged from marginal to significant â€” the order told its own story.",
    "Three teams lose drivers to Q1 today â€” a difficult afternoon of debrief conversations awaits.",
  ])}`);

  return [_pick(intros), ...drama.slice(0,3)].filter(Boolean);
}

function buildQ2Caption(q2, track){
  const sorted=[...q2].sort((a,b)=>b.score-a.score);
  const elim=q2.filter(e=>e.elim2);
  const fastest=sorted[0];
  const shockElim=elim.find(e=>e.q2Pos<=4);
  const tight=(sorted[9]?.score-sorted[10]?.score)<0.5;
  const tyreTheme=Math.random()<0.6;
  const gap=sorted[1]?((sorted[0].score-sorted[1].score)*0.011).toFixed(3):"0.000";
  const q3Drivers=sorted.filter(e=>!elim.includes(e));

  const intros=[
    `Q2 â€” ${track.circuit.toUpperCase()} | 15 MINUTES, 15 DRIVERS, FIVE SPOTS TO FILL IN Q3\n\n${fastest.driver.name} leads Q2 for ${fastest.team.name} as the session unfolds into a ${_pick(["tense","chaotic","strategically fascinating","brutally simple"])} fifteen minutes. The top ten advance; the bottom five go home. But this session carries a hidden dimension: the compound you set your fastest time on is the compound you start the race on tomorrow.`,
    `Q2 REPORT â€” ${track.name.toUpperCase()}\n\nFifteen drivers, fifteen minutes, and a tyre decision embedded in every flying lap. ${fastest.driver.name} led the way, but the tyre choices being made in the garages right now could define Sunday's race entirely. ${q3Drivers.slice(0,3).map(e=>e.driver.name).join(", ")} safely through â€” now they prepare for the shootout.`,
    `${fastest.driver.name} LEADS Q2 â€” but the story of this session isn't the lap time. It's the compound. ${_pick([
      `At least four drivers advanced to Q3 on mediums â€” a significant strategic variable for tomorrow.`,
      `Several teams chose hard tyres to make it through â€” a race-starting advantage if it works, a pace disadvantage if it doesn't.`,
      `The tyre allocation decisions made in the next eight minutes will be debated for years if they prove decisive.`,
    ])}`,
  ];

  const drama=[];
  if(shockElim) drama.push(`ELIMINATED â€” ${shockElim.driver.name}. The ${shockElim.team.name} driver, who had looked competitive all weekend, fails to make Q3. ${_pick([
    `A tyre temperature issue on the final run â€” the compound never came alive in the final sector.`,
    `The team's decision to save a set of softs for the race backfired disastrously.`,
    `An impeding incident in the final minutes destroyed their last chance at improvement.`,
    `Starting from P${shockElim.q2Pos+10||11} is not impossible, but it requires a perfect race and significant chaos ahead.`,
    `The championship damage from this qualifying result is substantial. A recovery drive is the only option now.`,
  ])}`);
  if(tight) drama.push(`P10 and P11 â€” the most painful borderline in motorsport. ${sorted[9]?.driver.name} advances; ${sorted[10]?.driver.name} does not. The gap was ${gap}s. ${_pick([
    "A tow denied. A traffic incident at the wrong moment. A tenth found or lost somewhere nobody expected.",
    "The kind of result that changes a team's entire weekend outlook.",
    "Tomorrow, the driver starting P11 faces a much longer route to points.",
    "Every driver on the bubble gave everything. The timing screen was the only judge.",
  ])}`);
  if(tyreTheme) drama.push(`The tyre strategies visible in Q2: ${q3Drivers.slice(0,3).map(e=>`${e.driver.name.split(" ").pop()} (${_pick(["softs","mediums"])})`).join(", ")} â€” this creates ${_pick([
    "a fascinating matrix of starting options for tomorrow's race director.",
    "genuine strategic differentiation at the sharp end of the grid.",
    "potential chaos in Turn 1 tomorrow if the soft-starters attack hard.",
  ])}. The engineers will be working deep into the night on race simulations.`);

  return [_pick(intros), ...drama.slice(0,3)].filter(Boolean);
}

function buildQ3Caption(q3, track){
  const sorted=[...q3].sort((a,b)=>b.score-a.score);
  const pole=sorted[0], p2=sorted[1], p3=sorted[2], p4=sorted[3];
  const gap=p2?((pole.score-p2.score)*0.011).toFixed(3):"0.000";
  const tight=parseFloat(gap)<0.15;
  const dominant=parseFloat(gap)>0.4;
  const rivalry=p2?getRivalry(pole.driver,p2.driver):null;
  const sameTeam=p2&&pole.team.id===p2.team.id;

  const intros=[
    `Q3 â€” ${track.circuit.toUpperCase()} | THE POLE POSITION SHOOTOUT\n\n${pole.driver.name}. Pole position. ${_pick([
      `A lap that silenced the paddock â€” ${gap}s to ${p2?.driver.name||"P2"}.`,
      `The ${pole.team.name} driver at their absolute best when it matters most.`,
      `A lap built from three perfect sectors â€” every corner a decision, every apex hit perfectly.`,
    ])} Starting from the front at ${track.circuit} is ${track.od>70?"not an automatic advantage â€” overtaking is possible but difficult":"a significant tactical weapon for tomorrow"}.`,
    `POLE: ${pole.driver.name} (${pole.team.name}) â€” ${fmtLap?fmtLap(pole.score*0.011+80):gap+"s gap"} â€” ${track.name.toUpperCase()}\n\n${_pick([
      `${gap}s clear of ${p2?.driver.name||"P2"} â€” a ${tight?"razor-thin":dominant?"commanding":"clear"} advantage heading into Sunday.`,
      `The team radio erupts. The garage erupts. ${pole.driver.name} pumps their fist through the cockpit opening.`,
      `Pole position number ${_pick(["three","seven","twelve","twenty-one","four"])} of their career â€” and perhaps the most important this season.`,
    ])}`,
    `IT'S ${pole.driver.name.toUpperCase()} ON POLE POSITION AT ${track.circuit.toUpperCase()}!\n\n${_pick([
      `A ${_pick(["masterpiece","statement","tour de force","perfect response to a difficult weekend"])} of a qualifying lap.`,
      `Built in the final sector â€” where others found the limit, ${pole.driver.name} found another tenth.`,
      `The final flying lap. Everything on the line. ${pole.driver.name} delivered.`,
    ])} The gap to ${p2?.driver.name||"P2"}: ${gap}s. On a day like today, that feels like a mile.`,
  ];

  const analysis=[
    sameTeam
      ?`${pole.team.name} lock out the front row â€” a ${_pick(["stunning","clinical","overwhelming","authoritative"])} team performance. ${p2?.driver.name} within ${gap}s of their team-mate means the garage dynamic tomorrow will be tense. Who blinks at Turn 1?`
      :`Front row: ${pole.driver.name} (${pole.team.name}) and ${p2?.driver.name} (${p2?.team.name}). ${_pick([
        "Two different strategies, two different approaches, one shared ambition.",
        "The clean side of the grid gives pole a marginal grip advantage at the start.",
        "The inside line into Turn 1 belongs to pole â€” unless something dramatic happens at the formation lap.",
      ])}`,
    rivalry
      ?`${rivalry.desc.charAt(0).toUpperCase()+rivalry.desc.slice(1)} â€” ${pole.driver.name} has the edge going into Sunday but ${p2?.driver.name} knows this race is decided over 57 laps, not over one flying lap at the end of qualifying.`
      :`${p3?`P3: ${p3.driver.name} (${p3.team.name}) â€” `:""}${_pick([
        "a starting position that has delivered race victories at this circuit in the past.",
        "a perfect platform if the front row makes contact at the start.",
        "the undercut target. If pit stop timing favours them, ${p3?p3.driver.name:'the P3 driver'} could be leading by lap thirty.",
      ])}`,
  ];

  const riskItems=[
    `WHAT COULD DECIDE TOMORROW: ${_pick([
      `Safety car probability at ${track.circuit} is historically ${track.hasSC||Math.random()<0.5?"high â€” any neutralisation period will compress the field and reset the race":"low â€” unless the lap 1 chaos everyone fears materialises"}. Whoever comes out of a safety car restart in front usually wins.`,
      `Tyre compound strategies diverge sharply from row three back. If the one-stoppers can make it work, the two-stopping front-runners face a nightmare of timing calculations.`,
      `${track.night?"Night conditions change tyres and strategy. The optimal pit window is compressed â€” small mistakes cost big.":`${track.street?"Pit lane entry is tight â€” a slow stop or a double-stack could cost a full second.":`Weather radar shows ${track.wr>40?"a significant rain risk tomorrow. If it comes, all of this qualifying data is irrelevant.":"no immediate threat but conditions can change quickly."}`}`}`,
    ])}`,
  ];

  return [_pick(intros), _pick(analysis), ...riskItems].filter(Boolean);
}


// â•‘  Reusable React components: Bar, MentalBar, TrackPicker, RivalPicker,  â•‘
// â•‘  STAGE_DEFS: the 7 Croft & Brundle commentary stages (lights out â†’     â•‘
const STAGE_DEFS=[
  {key:"start",   title:"LIGHTS OUT",      emoji:"ðŸš¦",color:"#E8002D",lapHint:"Laps 1â€“5"},
  {key:"early",   title:"EARLY RUNNING",   emoji:"âš¡",color:"#FF8844",lapHint:"Laps 6â€“20"},
  {key:"pits",    title:"PIT WINDOW",      emoji:"ðŸ”„",color:"#4488FF",lapHint:"Laps 20â€“55%"},
  {key:"mid",     title:"MID-RACE",        emoji:"ðŸ”¥",color:"#FFC906",lapHint:"40â€“65%"},
  {key:"midfield",title:"MIDFIELD MELEE",  emoji:"ðŸŽï¸",color:"#BB66FF",lapHint:"P8â€“P22"},
  {key:"closing", title:"CLOSING LAPS",    emoji:"ðŸ",color:"#44CC88",lapHint:"Final 20%"},
  {key:"podium",  title:"PODIUM",          emoji:"ðŸ†",color:"#FFD700",lapHint:"Post-Race"},
];

// ===================== MAIN APP =====================


// â•‘  F1Sim is the root React component. All state lives here.               â•‘
// â•‘  State:   drivers, teams, track, view, qual, sprint, race, stages,      â•‘
// â•‘                                                                          â•‘
// â•‘           â†’ testing â†’ multisim â†’ championship                           â•‘
// â•‘  Persistence: localStorage keys:                                         â•‘
// â•‘    f1sim_teams   â€” serialised team array                                â•‘

// â•‘  Shows on first load. F1 2027 is the only active series; F2/F3/F4/     â•‘
// â•‘  ready to be activated in future versions.                               â•‘

// â•‘  Anonymised race simulation data is sent to a Supabase backend.         â•‘
// â•‘  local model via Bayesian blending. All data is opt-in and anonymous.   â•‘



// ============================================================================
//  F1 SIM 2027 - PLATFORM UI
//  Full roleplay & championship management simulator
// ============================================================================

// -- React hooks (useRef not declared by engine section) ----------------------

var useRef = React.useRef;
var useEffect = React.useEffect;

// -- Supabase -----------------------------------------------------------------

const SUPABASE_URL = "https://tdsmjrbuplbjnajdzjnu.supabase.co";
const SUPABASE_KEY = "sb_publishable_XsC9JcwIvUb1ns7qeFegXw_CzsjStu2";

const sbClient = (typeof window !== 'undefined' && window.supabase && !SUPABASE_URL.includes('YOUR_PROJECT'))
  ? window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { autoRefreshToken: true, persistSession: true, storageKey: 'f1sim_auth' }
    })
  : null;

const sbFakeEmail = (u) => `${u.toLowerCase().replace(/[^a-z0-9_]/g,'')}@example.com`;

const GM_USERNAME = 'elfoghorn';

async function sbSignUp(username, password) {
  if (!sbClient) return { error: 'Supabase not configured' };
  const { data, error } = await sbClient.auth.signUp({
    email: sbFakeEmail(username), password,
    options: { data: { username, display_name: username } }
  });
  if (error) return { data: null, error: error.message };
  // Auto-GM for the league owner
  if (data?.user && username.toLowerCase() === GM_USERNAME) {
    await new Promise(r => setTimeout(r, 800));
    await sbFetchRaw(`profiles?id=eq.${data.user.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ role: 'gm' }),
      session: data.session,
    });
  }
  return { data, error: null };
}
async function sbSignIn(username, password) {
  if (!sbClient) return { error: 'Supabase not configured' };
  const { data, error } = await sbClient.auth.signInWithPassword({
    email: sbFakeEmail(username), password
  });
  return { data, error: error?.message || null };
}
async function sbSignOut() { if (sbClient) await sbClient.auth.signOut(); }

// Raw fetch — merges headers properly so apikey is never overwritten
async function sbFetchRaw(path, opts = {}) {
  const { headers: extraHeaders, session: sessionOverride, ...restOpts } = opts;
  const session = sessionOverride !== undefined
    ? sessionOverride
    : (sbClient ? (await sbClient.auth.getSession()).data.session : null);
  const baseHeaders = { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY };
  if (session) baseHeaders['Authorization'] = `Bearer ${session.access_token}`;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { ...baseHeaders, ...extraHeaders },
    ...restOpts,
  });
  if (!res.ok) { const e = await res.text(); return { data: null, error: e }; }
  const text = await res.text();
  return { data: text ? JSON.parse(text) : null, error: null };
}

async function sbFetch(path, opts = {}) {
  return sbFetchRaw(path, opts);
}

// -- Design tokens ------------------------------------------------------------

const FONT_HEAD = "'Barlow Condensed', sans-serif";
const FONT_BODY = "'IBM Plex Sans', system-ui, sans-serif";
const FONT_MONO = "'IBM Plex Mono', monospace";

const C = {
  bg:        '#0A0A0C',
  surface:   '#111114',
  card:      '#17171C',
  border:    '#252530',
  borderHov: '#3A3A48',
  red:       '#E8002D',
  redDark:   '#B00022',
  redGlow:   'rgba(232,0,45,0.18)',
  gold:      '#FFD700',
  silver:    '#C0C0C0',
  bronze:    '#CD7F32',
  text:      '#F0F0F5',
  textSub:   '#8888A0',
  textMuted: '#55556A',
  green:     '#00C46A',
  amber:     '#FF9500',
  blue:      '#3B8EFF',
  sidebar:   '#0D0D10',
  sideW:     220,
};

const T = {
  h1:   { fontSize:38, fontWeight:900, letterSpacing:-0.5, color:'#F0F0F5', fontFamily:FONT_HEAD, lineHeight:1.1 },
  h2:   { fontSize:26, fontWeight:700, color:'#F0F0F5', fontFamily:FONT_HEAD },
  h3:   { fontSize:18, fontWeight:600, color:'#F0F0F5', fontFamily:FONT_HEAD },
  body: { fontSize:14, color:'#F0F0F5', fontFamily:FONT_BODY },
  sub:  { fontSize:13, color:'#8888A0', fontFamily:FONT_BODY },
  cap:  { fontSize:11, fontWeight:500, letterSpacing:1.5, textTransform:'uppercase', color:'#55556A', fontFamily:FONT_MONO },
};

// -- Display maps (encoding-safe; engine DRIVING_STYLES/TRACKS use mojibake) --

const STYLE_DISPLAY = {
  aggressive: { icon:'🔥', label:'Aggressive',  tip:'Late-braking, high-risk overtakes, pushes hard from lap 1' },
  smooth:     { icon:'✈️',  label:'Smooth',      tip:'Minimal tyre wear, precise inputs, consistent lap times' },
  qualifier:  { icon:'⚡',        label:'Qualifier',   tip:'Flies in qualifying, struggles over race distance' },
  defender:   { icon:'🛡️', label:'Defender', tip:'Excellent at holding position, hard to pass cleanly' },
  charger:    { icon:'🏆',  label:'Charger',     tip:'Strong from behind, excellent mid-race overtaker' },
  strategist: { icon:'🧠',  label:'Strategist',  tip:'Reads the race perfectly, tyre and pit window specialist' },
  technical:  { icon:'🔧',  label:'Technical',   tip:'Excels on slow technical circuits, precise cornering' },
  ironman:    { icon:'💪',  label:'Ironman',     tip:'Maintains pace over full distance, legendary consistency' },
};

const TRACK_FLAG = {
  bahrain:        '🇧🇭',
  saudi_arabia:   '🇸🇦',
  australia:      '🇦🇺',
  japan:          '🇯🇵',
  china:          '🇨🇳',
  miami:          '🇺🇸',
  emilia_romagna: '🇮🇹',
  monaco:         '🇲🇨',
  canada:         '🇨🇦',
  spain:          '🇪🇸',
  austria:        '🇦🇹',
  great_britain:  '🇬🇧',
  hungary:        '🇭🇺',
  belgium:        '🇧🇪',
  netherlands:    '🇳🇱',
  italy:          '🇮🇹',
  azerbaijan:     '🇦🇿',
  singapore:      '🇸🇬',
  usa:            '🇺🇸',
  mexico:         '🇲🇽',
  brazil:         '🇧🇷',
  las_vegas:      '🇺🇸',
  qatar:          '🇶🇦',
  abu_dhabi:      '🇦🇪',
};

async function uploadCharacterPhoto(file, charId) {
  if (!sbClient) return { url: null, error: 'Not connected' };
  const sess = (await sbClient.auth.getSession()).data.session;
  if (!sess) return { url: null, error: 'Not signed in' };
  const ext = (file.name.split('.').pop() || 'jpg').toLowerCase();
  const path = `${charId}/${Date.now()}.${ext}`;
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/character-photos/${path}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${sess.access_token}`,
      'Content-Type': file.type || 'image/jpeg',
      'x-upsert': 'true',
    },
    body: file,
  });
  if (!res.ok) { const e = await res.text(); return { url: null, error: e }; }
  return { url: `${SUPABASE_URL}/storage/v1/object/public/character-photos/${path}`, error: null };
}

// -- Utility components -------------------------------------------------------

function Badge({ color, bg, children, style={} }) {
  const c = color || '#55556A';
  return (
    <span style={{ display:'inline-block', padding:'2px 8px', borderRadius:4,
      fontSize:11, fontWeight:600, letterSpacing:.5, textTransform:'uppercase',
      color: c, background: bg || c+'22', ...style }}>
      {children}
    </span>
  );
}

function StatusBadge({ status }) {
  const map = {
    draft:              { label:'Draft',           color:'#55556A' },
    submitted:          { label:'Submitted',       color:'#3B8EFF' },
    under_review:       { label:'Under Review',    color:'#FF9500' },
    revision_requested: { label:'Revision Needed', color:'#FF9500' },
    approved:           { label:'Approved',        color:'#00C46A' },
    rejected:           { label:'Rejected',        color:'#E8002D' },
    archived:           { label:'Archived',        color:'#55556A' },
  };
  const s = map[status] || map.draft;
  return <Badge color={s.color}>{s.label}</Badge>;
}

function Card({ children, style={}, onClick }) {
  const [hov, setHov] = useState(false);
  return (
    <div onClick={onClick}
      onMouseEnter={() => onClick && setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{ background:'#17171C', border:`1px solid ${hov ? '#3A3A48' : '#252530'}`,
        borderRadius:10, padding:20, cursor: onClick ? 'pointer' : 'default',
        transition:'border-color .15s', ...style }}>
      {children}
    </div>
  );
}

function Button({ children, onClick, variant='primary', disabled, style={}, size='md' }) {
  const [hov, setHov] = useState(false);
  const pad = size === 'sm' ? '6px 14px' : size === 'lg' ? '12px 28px' : '9px 20px';
  const fs  = size === 'sm' ? 12 : size === 'lg' ? 16 : 14;
  const bgMap = {
    primary:   hov ? '#B00022' : '#E8002D',
    secondary: hov ? '#3A3A48' : '#252530',
    ghost:     hov ? '#252530' : 'transparent',
    danger:    hov ? '#900020' : '#700018',
    success:   hov ? '#009950' : '#00C46A',
  };
  const fgMap = {
    primary:'#fff', secondary:'#F0F0F5', ghost:'#8888A0', danger:'#fff', success:'#fff'
  };
  return (
    <button disabled={disabled} onClick={onClick}
      onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      style={{ border:'none', borderRadius:7, fontWeight:600, fontSize:fs,
        cursor: disabled ? 'not-allowed' : 'pointer', padding:pad, transition:'all .15s',
        opacity: disabled ? .5 : 1, background: bgMap[variant], color: fgMap[variant], ...style }}>
      {children}
    </button>
  );
}

function Input({ label, value, onChange, placeholder, type='text', error, style={} }) {
  return (
    <div style={{ marginBottom:14 }}>
      {label && <div style={{ ...T.cap, marginBottom:5 }}>{label}</div>}
      <input type={type} value={value} onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        style={{ width:'100%', background:'#111114', border:`1px solid ${error ? '#E8002D' : '#252530'}`,
          borderRadius:7, padding:'9px 12px', color:'#F0F0F5', fontSize:14, outline:'none',
          boxSizing:'border-box', ...style }} />
      {error && <div style={{ fontSize:12, color:'#E8002D', marginTop:4 }}>{error}</div>}
    </div>
  );
}

function Textarea({ label, value, onChange, placeholder, rows=4, style={} }) {
  return (
    <div style={{ marginBottom:14 }}>
      {label && <div style={{ ...T.cap, marginBottom:5 }}>{label}</div>}
      <textarea rows={rows} value={value} onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        style={{ width:'100%', background:'#111114', border:'1px solid #252530',
          borderRadius:7, padding:'9px 12px', color:'#F0F0F5', fontSize:14, outline:'none',
          resize:'vertical', boxSizing:'border-box', ...style }} />
    </div>
  );
}

function Select({ label, value, onChange, options, style={} }) {
  return (
    <div style={{ marginBottom:14 }}>
      {label && <div style={{ ...T.cap, marginBottom:5 }}>{label}</div>}
      <select value={value} onChange={e => onChange(e.target.value)}
        style={{ width:'100%', background:'#111114', border:'1px solid #252530',
          borderRadius:7, padding:'9px 12px', color:'#F0F0F5', fontSize:14, outline:'none', ...style }}>
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  );
}

function StatBar({ label, value, max=99, color }) {
  const c = color || '#E8002D';
  return (
    <div style={{ marginBottom:8 }}>
      <div style={{ display:'flex', justifyContent:'space-between', marginBottom:3 }}>
        <span style={{ ...T.cap }}>{label}</span>
        <span style={{ fontSize:12, fontWeight:700, color: c }}>{value}</span>
      </div>
      <div style={{ height:5, background:'#252530', borderRadius:3 }}>
        <div style={{ height:'100%', width:`${(value/max)*100}%`, background:c, borderRadius:3,
          transition:'width .3s' }} />
      </div>
    </div>
  );
}

function Spinner() {
  return (
    <div style={{ display:'flex', alignItems:'center', justifyContent:'center', padding:40 }}>
      <div style={{ width:28, height:28, border:'3px solid #252530', borderTopColor:'#E8002D',
        borderRadius:'50%', animation:'spin 0.7s linear infinite' }} />
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}

function EmptyState({ title, sub, action }) {
  return (
    <div style={{ textAlign:'center', padding:'60px 20px' }}>
      <div style={{ width:48, height:48, borderRadius:'50%', background:'#17171C',
        margin:'0 auto 16px', border:'2px solid #252530' }} />
      <div style={{ ...T.h3, marginBottom:6 }}>{title}</div>
      {sub && <div style={{ ...T.sub, marginBottom:16 }}>{sub}</div>}
      {action}
    </div>
  );
}

// -- Sidebar ------------------------------------------------------------------

const NAV_ITEMS = [
  { id:'dashboard',    label:'Dashboard' },
  { id:'characters',   label:'My Characters' },
  { id:'team',         label:'My Team' },
  { id:'apply',        label:'Apply' },
  { id:'teams',        label:'Teams' },
  { id:'championship', label:'Championship' },
  { id:'calendar',     label:'Calendar' },
  { id:'stats',        label:'Statistics' },
  { id:'search',       label:'Search' },
  { id:'notifications',label:'Notifications' },
  { id:'settings',     label:'Settings' },
  null,
  { id:'gm',           label:'GM Control',   gmOnly: true },
  { id:'sandbox',      label:'Sandbox' },
];

class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(e) { return { error: e }; }
  componentDidCatch(e, info) { console.error('F1Sim render error:', e, info); }
  render() {
    if (this.state.error) {
      return React.createElement('div', {
        style: { padding:32, fontFamily:'IBM Plex Mono, monospace', background:'#0A0A0C',
          minHeight:'100vh', color:'#F0F0F5' }
      },
        React.createElement('div', { style:{ fontSize:20, fontWeight:700, color:'#E8002D', marginBottom:12 } },
          'Render Error'),
        React.createElement('pre', { style:{ fontSize:12, color:'#FF9500', whiteSpace:'pre-wrap',
          background:'#111114', padding:16, borderRadius:8, border:'1px solid #252530' } },
          String(this.state.error?.message || this.state.error)),
        React.createElement('pre', { style:{ fontSize:11, color:'#55556A', whiteSpace:'pre-wrap',
          marginTop:12, background:'#111114', padding:16, borderRadius:8, border:'1px solid #252530' } },
          String(this.state.error?.stack || '')),
        React.createElement('button', {
          onClick: () => this.setState({ error: null }),
          style:{ marginTop:16, padding:'8px 20px', background:'#E8002D', border:'none',
            borderRadius:6, color:'#fff', cursor:'pointer', fontFamily:'IBM Plex Mono, monospace' }
        }, 'Dismiss')
      );
    }
    return this.props.children;
  }
}

function Sidebar({ page, setPage, profile, unreadCount=0 }) {
  const isGM = profile?.role === 'gm' || profile?.role === 'admin';
  return (
    <div style={{ width:220, minWidth:220, background:'#0D0D10',
      borderRight:'1px solid #252530', display:'flex', flexDirection:'column',
      height:'100vh', position:'sticky', top:0, overflowY:'auto' }}>
      <div style={{ padding:'20px 16px 16px', borderBottom:'1px solid #252530' }}>
        <div style={{ fontSize:22, fontWeight:900, letterSpacing:2, color:'#E8002D', fontFamily:FONT_HEAD }}>F1 SIM</div>
        <div style={{ fontSize:10, color:'#55556A', letterSpacing:2, textTransform:'uppercase', fontFamily:FONT_MONO }}>2027 League</div>
      </div>
      <nav style={{ flex:1, padding:'8px 0' }}>
        {NAV_ITEMS.map((item, i) => {
          if (!item) return <div key={i} style={{ height:1, background:'#252530', margin:'6px 10px' }} />;
          if (item.gmOnly && !isGM) return null;
          const active = page === item.id;
          return (
            <button key={item.id} onClick={() => setPage(item.id)}
              style={{ display:'flex', alignItems:'center', justifyContent:'space-between',
                width:'100%', padding:'9px 16px',
                border:'none', borderLeft:`3px solid ${active ? '#E8002D' : 'transparent'}`,
                background: active ? 'rgba(232,0,45,0.18)' : 'transparent',
                color: active ? '#F0F0F5' : '#8888A0', cursor:'pointer', fontSize:13,
                fontWeight: active ? 600 : 400, textAlign:'left', transition:'all .15s' }}>
              {item.label}
              {item.id === 'notifications' && unreadCount > 0 &&
                <span style={{ background:'#E8002D', color:'#fff',
                  borderRadius:10, fontSize:10, fontWeight:700, padding:'2px 6px' }}>
                  {unreadCount}
                </span>}
            </button>
          );
        })}
      </nav>
      {profile && (
        <div style={{ padding:'12px 16px', borderTop:'1px solid #252530' }}>
          <div style={{ display:'flex', alignItems:'center', gap:8 }}>
            <div style={{ width:32, height:32, borderRadius:'50%', background:'#252530',
              display:'flex', alignItems:'center', justifyContent:'center',
              fontSize:14, fontWeight:700, color:'#E8002D' }}>
              {(profile.username||'?')[0].toUpperCase()}
            </div>
            <div style={{ flex:1, minWidth:0 }}>
              <div style={{ fontSize:13, fontWeight:600, color:'#F0F0F5',
                overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                {profile.username}
              </div>
              <div style={{ fontSize:11, color:'#55556A', textTransform:'uppercase', letterSpacing:.5 }}>
                {profile.role}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// -- Auth Screen --------------------------------------------------------------

function AuthScreen({ onLogin }) {
  const [mode, setMode] = useState('signin');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function submit(e) {
    e.preventDefault();
    setError('');
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
      setError('Username: 3-20 chars, letters/numbers/underscore only');
      return;
    }
    if (password.length < 6) { setError('Password must be at least 6 characters'); return; }
    setLoading(true);
    const fn = mode === 'signup' ? sbSignUp : sbSignIn;
    const { data, error: err } = await fn(username, password);
    setLoading(false);
    if (err) { setError(err); return; }
    if (data?.user) onLogin(data.user, data.session);
  }

  return (
    <div style={{ minHeight:'100vh', background:'#0A0A0C', display:'flex',
      alignItems:'center', justifyContent:'center', fontFamily:FONT_BODY }}>
      <div style={{ width:'100%', maxWidth:400, padding:20 }}>
        <div style={{ textAlign:'center', marginBottom:40 }}>
          <div style={{ fontSize:48, fontWeight:900, letterSpacing:2, color:'#E8002D', fontFamily:FONT_HEAD }}>F1 SIM</div>
          <div style={{ fontSize:11, color:'#55556A', letterSpacing:3, textTransform:'uppercase', fontFamily:FONT_MONO }}>2027 Championship</div>
        </div>
        <Card>
          <div style={{ display:'flex', gap:0, marginBottom:20, background:'#111114',
            borderRadius:8, padding:4 }}>
            {['signin','signup'].map(m => (
              <button key={m} onClick={() => setMode(m)}
                style={{ flex:1, padding:'8px 0', border:'none', borderRadius:6, fontSize:13,
                  fontWeight:600, cursor:'pointer',
                  background: mode === m ? '#17171C' : 'transparent',
                  color: mode === m ? '#F0F0F5' : '#8888A0' }}>
                {m === 'signin' ? 'Sign In' : 'Register'}
              </button>
            ))}
          </div>
          <form onSubmit={submit}>
            <Input label="Username" value={username} onChange={setUsername} placeholder="e.g. driver_27" />
            <Input label="Password" type="password" value={password} onChange={setPassword}
              placeholder="Min 6 characters" error={error} />
            <Button disabled={loading} style={{ width:'100%' }} size='lg'>
              {loading ? 'Loading...' : mode === 'signup' ? 'Create Account' : 'Sign In'}
            </Button>
          </form>
          {mode === 'signup' && (
            <div style={{ marginTop:12, fontSize:12, color:'#55556A', textAlign:'center' }}>
              Only your username is visible to others.
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

// -- Dashboard ----------------------------------------------------------------

function Dashboard({ profile, setPage, sbUser }) {
  const [chars,      setChars]      = useState(null);
  const [nextRound,  setNextRound]  = useState(null);
  const [latestRace, setLatestRace] = useState(null);
  const [appStats,   setAppStats]   = useState({ pending:0, approved:0 });
  const [activity,   setActivity]   = useState([]);
  const [loaded,     setLoaded]     = useState(false);
  const isGM = profile?.role === 'gm' || profile?.role === 'admin';

  if (!loaded) {
    setLoaded(true);
    if (sbClient && sbUser) {
      sbFetch(`characters?owner_id=eq.${sbUser.id}&order=created_at.desc&limit=6`)
        .then(({ data }) => setChars(data || []));
      sbFetch('rounds?state=in.(scheduled,orders_open,locked,in_progress)&order=scheduled_for.asc&limit=1')
        .then(({ data }) => setNextRound(data?.[0] || null));
      sbFetch(`applications?applicant_id=eq.${sbUser.id}&select=status`)
        .then(({ data }) => {
          const apps = data || [];
          setAppStats({
            pending:  apps.filter(a => ['submitted','under_review','revision_requested'].includes(a.status)).length,
            approved: apps.filter(a => a.status === 'approved').length,
          });
        });
      sbFetch(`notifications?recipient_id=eq.${sbUser.id}&order=created_at.desc&limit=5`)
        .then(({ data }) => setActivity(data || []));
      sbFetch('session_runs?status=eq.final&session=eq.race&order=created_at.desc&limit=1&select=*')
        .then(({ data }) => setLatestRace(data?.[0] || null));
    } else {
      setChars([]);
    }
  }

  const rlbl = s => ({ scheduled:'Scheduled', orders_open:'Orders Open', locked:'Locked',
    in_progress:'Live', complete:'Complete' }[s] || s);
  const rclr = s => ({ scheduled:'#55556A', orders_open:'#3B8EFF', locked:'#FF9500',
    in_progress:'#E8002D', complete:'#00C46A' }[s] || '#55556A');

  const statCards = [
    { label:'Characters',    value: chars === null ? '...' : chars.length,  color:'#3B8EFF', page:'characters' },
    { label:'Applications',  value: appStats.pending,                        color:'#FF9500', page:'apply' },
    { label:'Approved',      value: appStats.approved,                       color:'#00C46A', page:'apply' },
    { label:'Next Race',
      value: nextRound ? (nextRound.circuit_id || 'TBD') : '--',
      color:'#E8002D', page:'calendar' },
  ];

  return (
    <div>
      <div style={{ marginBottom:28 }}>
        <div style={{ ...T.cap, color:'#E8002D', marginBottom:6 }}>Player Portal</div>
        <div style={{ ...T.h1, marginBottom:4 }}>Welcome back, {profile?.username}</div>
        <div style={{ ...T.sub }}>Formula One 2027 Roleplay Championship</div>
      </div>

      {/* Stat strip */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:12, marginBottom:28 }}>
        {statCards.map(s => (
          <Card key={s.label} onClick={() => setPage(s.page)} style={{ padding:'16px 20px' }}>
            <div style={{ ...T.cap, marginBottom:8 }}>{s.label}</div>
            <div style={{ fontSize:32, fontWeight:900, fontFamily:FONT_HEAD,
              color:s.color, lineHeight:1 }}>{s.value}</div>
          </Card>
        ))}
      </div>

      {/* Two-column layout */}
      <div style={{ display:'grid', gridTemplateColumns:'1fr 280px', gap:20, alignItems:'start' }}>

        {/* Characters */}
        <div>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:14 }}>
            <div style={{ ...T.h2 }}>My Characters</div>
            <Button size='sm' onClick={() => setPage('characters')}>+ New</Button>
          </div>
          {chars === null ? <Spinner /> : chars.length === 0 ? (
            <Card style={{ textAlign:'center', padding:'32px 20px' }}>
              <div style={{ ...T.h3, marginBottom:6, color:'#55556A' }}>No characters yet</div>
              <div style={{ ...T.sub, marginBottom:16 }}>Create your first driver or staff character to join the grid</div>
              <Button onClick={() => setPage('characters')}>Create Character</Button>
            </Card>
          ) : (
            <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(260px,1fr))', gap:12 }}>
              {chars.map(c => (
                <Card key={c.id}>
                  <div style={{ display:'flex', alignItems:'center', gap:12,
                    marginBottom: c.type === 'driver' ? 12 : 0 }}>
                    <div style={{ width:44, height:44, borderRadius:'50%', background:'#252530',
                      display:'flex', alignItems:'center', justifyContent:'center',
                      fontSize:16, fontWeight:800, color:'#E8002D',
                      fontFamily:FONT_HEAD, flexShrink:0 }}>
                      {c.number || (c.name||'?')[0].toUpperCase()}
                    </div>
                    <div style={{ flex:1, minWidth:0 }}>
                      <div style={{ ...T.h3, whiteSpace:'nowrap', overflow:'hidden',
                        textOverflow:'ellipsis' }}>{c.name}</div>
                      <div style={{ display:'flex', alignItems:'center', gap:6, marginTop:3 }}>
                        <span style={{ ...T.cap }}>{c.type}</span>
                        <Badge color={c.is_active ? '#00C46A' : '#55556A'}>
                          {c.is_active ? 'Active' : 'Inactive'}
                        </Badge>
                      </div>
                    </div>
                  </div>
                  {c.type === 'driver' && (
                    <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'0 16px' }}>
                      <StatBar label="Pace"        value={c.pace||0}        color="#E8002D" />
                      <StatBar label="Consistency" value={c.consistency||0} color="#3B8EFF" />
                    </div>
                  )}
                  {c.bio && (
                    <div style={{ ...T.sub, fontSize:12, marginTop:8, fontStyle:'italic',
                      borderTop:'1px solid #252530', paddingTop:8 }}>
                      "{c.bio}"
                    </div>
                  )}
                </Card>
              ))}
            </div>
          )}
        </div>

        {/* Right sidebar */}
        <div style={{ display:'flex', flexDirection:'column', gap:14 }}>

          {/* Next race */}
          <Card>
            <div style={{ ...T.cap, color:'#E8002D', marginBottom:10 }}>Next Race</div>
            {nextRound ? (
              <div>
                <div style={{ ...T.h3, marginBottom:6 }}>{nextRound.circuit_id || 'Circuit TBD'}</div>
                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                  <div style={{ ...T.sub, fontSize:12 }}>
                    {nextRound.scheduled_for
                      ? new Date(nextRound.scheduled_for).toLocaleDateString('en-GB',
                          { day:'numeric', month:'short', year:'numeric' })
                      : 'Date TBD'}
                  </div>
                  <Badge color={rclr(nextRound.state)}>{rlbl(nextRound.state)}</Badge>
                </div>
                <Button size='sm' variant='secondary' style={{ width:'100%', marginTop:12 }}
                  onClick={() => setPage('calendar')}>View Calendar</Button>
              </div>
            ) : (
              <div>
                <div style={{ ...T.sub, marginBottom:10 }}>No upcoming races scheduled</div>
                <Button size='sm' variant='secondary' style={{ width:'100%' }}
                  onClick={() => setPage('calendar')}>View Calendar</Button>
              </div>
            )}
          </Card>

          {/* Quick actions */}
          <Card>
            <div style={{ ...T.cap, color:'#E8002D', marginBottom:10 }}>Quick Actions</div>
            <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
              {[
                ['Create Character',   'characters'],
                ['Submit Application', 'apply'],
                ['View Championship',  'championship'],
                ['Browse Teams',       'teams'],
              ].map(([lbl, pg]) => (
                <button key={pg} onClick={() => setPage(pg)}
                  style={{ width:'100%', padding:'9px 14px', background:'#111114',
                    border:'1px solid #252530', borderRadius:7,
                    color:'#8888A0', fontSize:13, fontFamily:FONT_BODY,
                    textAlign:'left', cursor:'pointer', transition:'all .15s' }}
                  onMouseEnter={e => { e.currentTarget.style.borderColor='#3A3A48';
                    e.currentTarget.style.color='#F0F0F5'; }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor='#252530';
                    e.currentTarget.style.color='#8888A0'; }}>
                  {lbl}
                </button>
              ))}
            </div>
          </Card>

          {/* Latest race results */}
          {latestRace && (latestRace.result?.placements?.length > 0) && (() => {
            const placements = latestRace.result.placements.slice(0,10);
            const podium = ['#FFD700','#C0C0C0','#CD7F32'];
            return (
              <Card>
                <div style={{ ...T.cap, color:'#E8002D', marginBottom:4 }}>Latest Race Results</div>
                <div style={{ ...T.sub, fontSize:11, color:'#55556A', marginBottom:10 }}>
                  {latestRace.circuit_name || latestRace.round_id?.slice(0,8) || 'Most recent race'}
                </div>
                <div style={{ display:'flex', flexDirection:'column', gap:3 }}>
                  {placements.map((p, i) => {
                    const pc = podium[i] || '#8888A0';
                    const name = p.driver || p.name || `P${i+1}`;
                    const time = p.time || p.gap || '';
                    return (
                      <div key={i} style={{ display:'flex', alignItems:'center', gap:8,
                        padding:'4px 6px', borderRadius:4,
                        background: i < 3 ? pc+'11' : 'transparent' }}>
                        <div style={{ fontWeight:900, fontSize:14, color:pc, minWidth:20,
                          fontFamily:FONT_HEAD, textAlign:'center' }}>{i+1}</div>
                        <div style={{ flex:1, fontSize:12, color:'#F0F0F5',
                          whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{name}</div>
                        {time && (
                          <div style={{ fontSize:10, color:'#8888A0', fontFamily:FONT_MONO,
                            whiteSpace:'nowrap' }}>{time}</div>
                        )}
                      </div>
                    );
                  })}
                </div>
                <Button size='sm' variant='secondary' style={{ width:'100%', marginTop:10 }}
                  onClick={() => setPage('stats')}>Full Results</Button>
              </Card>
            );
          })()}

          {/* Recent activity */}
          {activity.length > 0 && (
            <Card>
              <div style={{ ...T.cap, color:'#E8002D', marginBottom:10 }}>Recent Activity</div>
              <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
                {activity.map(n => (
                  <div key={n.id} style={{ paddingBottom:8, borderBottom:'1px solid #252530' }}>
                    <div style={{ ...T.sub, fontSize:12 }}>
                      {n.payload?.message || n.kind || 'Notification'}
                    </div>
                    <div style={{ ...T.cap, marginTop:3, fontSize:10 }}>
                      {new Date(n.created_at).toLocaleDateString()}
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </div>
      </div>

      {/* GM banner */}
      {isGM && (
        <div style={{ marginTop:24 }}>
          <Card onClick={() => setPage('gm')} style={{ borderColor:'rgba(232,0,45,0.4)', cursor:'pointer' }}>
            <div style={{ display:'flex', alignItems:'center', gap:14 }}>
              <div style={{ width:4, height:48, background:'#E8002D', borderRadius:2, flexShrink:0 }} />
              <div style={{ flex:1 }}>
                <div style={{ ...T.h3, color:'#E8002D' }}>GM Control Centre</div>
                <div style={{ ...T.sub }}>Manage players, approve applications, run races</div>
              </div>
              <div style={{ ...T.cap, color:'#E8002D' }}>Open &gt;</div>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}

// -- Character Detail View --------------------------------------------------

function StatRollerSection({ char: c, onSaved }) {
  const TIER_RANGES = {
    rookie:  { min:55, max:70,  pts:8  },
    regular: { min:65, max:80,  pts:8  },
    veteran: { min:72, max:85,  pts:10 },
    elite:   { min:80, max:90,  pts:10 },
    legend:  { min:87, max:96,  pts:12 },
  };
  const tier     = c.stat_roll_tier || 'regular';
  const range    = TIER_RANGES[tier] || TIER_RANGES.regular;
  const isDriver = c.type === 'driver';

  const DRIVER_STATS = ['pace','consistency','wet','overtaking','defense'];
  const STAFF_STATS  = ['technical','strategy_skill','leadership','morale'];
  const statKeys     = isDriver ? DRIVER_STATS : STAFF_STATS;
  const statLabels   = {
    pace:'Pace', consistency:'Consistency', wet:'Wet Skill',
    overtaking:'Overtaking', defense:'Defense',
    technical:'Technical', strategy_skill:'Strategy', leadership:'Leadership', morale:'Morale',
  };
  const statColors   = {
    pace:'#E8002D', consistency:'#3B8EFF', wet:'#3B8EFF',
    overtaking:'#FF9500', defense:'#FF9500',
    technical:'#3B8EFF', strategy_skill:'#E8002D', leadership:'#FF9500', morale:'#00C46A',
  };

  function roll() {
    const r = {};
    statKeys.forEach(k => {
      r[k] = Math.floor(Math.random() * (range.max - range.min + 1)) + range.min;
    });
    return r;
  }

  const [rolled,  setRolled]  = useState(null);
  const [boosts,  setBoosts]  = useState(() => Object.fromEntries(statKeys.map(k => [k, 0])));
  const [saving,  setSaving]  = useState(false);
  const [locked,  setLocked]  = useState(false);

  const totalBoost = Object.values(boosts).reduce((a,b)=>a+b, 0);
  const ptsLeft    = range.pts - totalBoost;

  function doRoll() {
    setRolled(roll());
    setBoosts(Object.fromEntries(statKeys.map(k => [k, 0])));
    setLocked(false);
  }

  function adjustBoost(k, delta) {
    const cur = boosts[k];
    const next = cur + delta;
    if (next < 0) return;
    if (next > 5) return;
    if (delta > 0 && ptsLeft < 1) return;
    setBoosts(b => ({...b, [k]: next}));
  }

  async function save() {
    if (!rolled) return;
    setSaving(true);
    const payload = {};
    statKeys.forEach(k => {
      payload[k] = Math.min(range.max + 5, (rolled[k] || range.min) + (boosts[k] || 0));
    });
    payload.stat_roll_pending = false;
    await sbFetch(`characters?id=eq.${c.id}`, {
      method:'PATCH', body: JSON.stringify(payload)
    });
    setSaving(false);
    setLocked(true);
    onSaved && onSaved(payload);
  }

  const TIER_COLORS = { rookie:'#3B8EFF', regular:'#F0F0F5', veteran:'#FF9500', elite:'#FFD700', legend:'#E8002D' };
  const tColor = TIER_COLORS[tier] || '#F0F0F5';

  return (
    <Card style={{ border:'1px solid #FFD70088', marginBottom:0 }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:14 }}>
        <div>
          <div style={{ ...T.cap, color:'#FFD700', marginBottom:4 }}>Stat Roll Available</div>
          <div style={{ ...T.h3 }}>
            Tier: <span style={{ color:tColor }}>{tier.charAt(0).toUpperCase()+tier.slice(1)}</span>
            <span style={{ ...T.cap, marginLeft:12 }}>Range {range.min}–{range.max}</span>
          </div>
        </div>
        {!locked && (
          <Button onClick={doRoll} variant={rolled?'secondary':'success'}>
            {rolled ? 'Re-Roll' : 'Roll Stats'}
          </Button>
        )}
      </div>

      {!rolled && (
        <div style={{ ...T.sub, fontSize:13 }}>
          Click Roll Stats to generate your base stats within your tier range.
          You will have {range.pts} influence points to boost individual stats by up to +5 each.
        </div>
      )}

      {rolled && !locked && (
        <div>
          <div style={{ display:'flex', justifyContent:'space-between', marginBottom:10 }}>
            <div style={{ ...T.cap }}>Adjust with influence points</div>
            <div style={{ ...T.cap, color: ptsLeft === 0 ? '#00C46A' : '#FFD700' }}>
              {ptsLeft} pts remaining
            </div>
          </div>
          {statKeys.map(k => {
            const base  = rolled[k] || range.min;
            const boost = boosts[k] || 0;
            const final = base + boost;
            const color = statColors[k] || '#55556A';
            return (
              <div key={k} style={{ marginBottom:10 }}>
                <div style={{ display:'flex', justifyContent:'space-between', marginBottom:4, alignItems:'center' }}>
                  <span style={{ ...T.cap }}>{statLabels[k]}</span>
                  <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                    <span style={{ fontSize:11, color:'#55556A', fontFamily:FONT_MONO }}>
                      {base} {boost > 0 && `+${boost}`}
                    </span>
                    <span style={{ fontSize:16, fontWeight:900, color, fontFamily:FONT_HEAD, width:28, textAlign:'right' }}>
                      {final}
                    </span>
                    <button onClick={() => adjustBoost(k, -1)} disabled={boost===0}
                      style={{ width:24, height:24, border:'1px solid #252530', borderRadius:4,
                        background:'#111114', color:'#F0F0F5', cursor:'pointer', fontSize:14,
                        lineHeight:1, opacity: boost===0?0.4:1 }}>-</button>
                    <button onClick={() => adjustBoost(k, 1)}
                      disabled={boost>=5 || ptsLeft===0}
                      style={{ width:24, height:24, border:'1px solid #252530', borderRadius:4,
                        background:'#111114', color:'#F0F0F5', cursor:'pointer', fontSize:14,
                        lineHeight:1, opacity:(boost>=5||ptsLeft===0)?0.4:1 }}>+</button>
                  </div>
                </div>
                <div style={{ height:4, background:'#252530', borderRadius:2 }}>
                  <div style={{ height:'100%', background:color, borderRadius:2,
                    width:`${final}%`, transition:'width .2s' }} />
                </div>
              </div>
            );
          })}
          <Button onClick={save} disabled={saving} style={{ marginTop:12 }}>
            {saving ? 'Saving...' : 'Confirm & Save Stats'}
          </Button>
        </div>
      )}

      {locked && (
        <div style={{ ...T.body, color:'#00C46A' }}>
          Stats saved! Your character stats have been set.
        </div>
      )}
    </Card>
  );
}

function CharacterDetail({ char: initChar, onBack, sbUser }) {
  const [c, setC] = useState(initChar);
  const [editing, setEditing] = useState(false);
  const isDriver  = c.type === 'driver';
  const canEdit = !!(sbUser && c.owner_id && sbUser.id === c.owner_id);

  function onStatsSaved(payload) {
    setC(prev => ({ ...prev, ...payload, stat_roll_pending: false }));
  }

  const driverStats = isDriver ? [
    ['Pace',          c.pace,        '#E8002D'],
    ['Consistency',   c.consistency, '#3B8EFF'],
    ['Wet Skill',     c.wet,         '#3B8EFF'],
    ['Overtaking',    c.overtaking,  '#FF9500'],
    ['Defense',       c.defense,     '#FF9500'],
    ['Experience',    c.experience,  '#55556A'],
  ] : [];
  const staffStats = !isDriver ? [
    ['Technical',     c.technical,       '#3B8EFF'],
    ['Strategy',      c.strategy_skill,  '#3B8EFF'],
    ['Leadership',    c.leadership,      '#FF9500'],
    ['Morale',        c.morale,          '#00C46A'],
  ] : [];
  const stats = isDriver ? driverStats : staffStats;

  if (editing) return (
    <CharacterEditForm char={c} onDone={updated => {
      if (updated) setC(updated);
      setEditing(false);
    }} />
  );

  return (
    <div style={{ maxWidth:760 }}>
      {/* Back */}
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:20 }}>
        <button onClick={onBack}
          style={{ background:'none', border:'none', color:'#8888A0',
            cursor:'pointer', fontSize:14, fontFamily:FONT_BODY,
            display:'flex', alignItems:'center', gap:6, padding:0 }}>
          &lt; Back to My Characters
        </button>
        {canEdit && (
          <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>Edit Profile</Button>
        )}
      </div>

      {/* Stat roll prompt */}
      {c.stat_roll_pending && (
        <div style={{ marginBottom:20 }}>
          <StatRollerSection char={c} onSaved={onStatsSaved} />
        </div>
      )}

      {/* Header */}
      <div style={{ display:'flex', alignItems:'flex-start', gap:20, marginBottom:28 }}>
        {c.photo_url ? (
          <img src={c.photo_url} alt={c.name}
            style={{ width:88, height:88, borderRadius:'50%', objectFit:'cover', flexShrink:0,
              border:'2px solid #E8002D' }} />
        ) : (
          <div style={{ width:88, height:88, borderRadius:'50%', background:'#252530',
            display:'flex', alignItems:'center', justifyContent:'center',
            fontSize:32, fontWeight:900, color:'#E8002D', fontFamily:FONT_HEAD, flexShrink:0 }}>
            {c.number || (c.name||'?')[0].toUpperCase()}
          </div>
        )}
        <div style={{ flex:1 }}>
          <div style={{ ...T.cap, color:'#E8002D', marginBottom:4 }}>
            {c.type}{c.number ? ` -- #${c.number}` : ''}{c.abbr ? ` -- ${c.abbr}` : ''}
          </div>
          <div style={{ ...T.h1, marginBottom:8 }}>{c.name}</div>
          <div style={{ display:'flex', gap:8, flexWrap:'wrap', marginBottom:8 }}>
            {c.nationality && <Badge color="#3B8EFF">{c.nationality}</Badge>}
            <Badge color={c.is_active ? '#00C46A' : '#55556A'}>
              {c.is_active ? 'Active' : 'Inactive'}
            </Badge>
            {(c.sim_style || c.style || c.driving_style) && (() => {
              const styleId = c.sim_style || c.style;
              const ds = styleId && DRIVING_STYLES.find(s => s.id === styleId);
              return (
                <Badge color={ds ? (ds.color||'#FF9500') : '#FF9500'}>
                  {ds ? (ds.icon ? ds.icon+' ' : '') + ds.id : (c.driving_style || c.style)}
                </Badge>
              );
            })()}
            {c.stat_roll_tier && !c.stat_roll_pending && (
              <Badge color="#FFD700">{c.stat_roll_tier} tier</Badge>
            )}
          </div>
          {/* Quick bio facts */}
          <div style={{ display:'flex', gap:16, flexWrap:'wrap' }}>
            {c.age    && <span style={{ ...T.cap }}>Age: {c.age}</span>}
            {c.height && <span style={{ ...T.cap }}>Height: {c.height}</span>}
          </div>
        </div>
      </div>

      {/* Iconic quote */}
      {c.iconic_quote && (
        <Card style={{ marginBottom:20, borderLeft:'3px solid #E8002D' }}>
          <div style={{ ...T.sub, fontStyle:'italic', fontSize:16, lineHeight:1.7,
            color:'#F0F0F5' }}>
            "{c.iconic_quote}"
          </div>
        </Card>
      )}

      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16 }}>

        {/* Stats */}
        {stats.length > 0 && (
          <Card>
            <div style={{ ...T.cap, color:'#E8002D', marginBottom:14 }}>
              {isDriver ? 'Driver Statistics' : 'Staff Statistics'}
            </div>
            {stats.map(([label, val, color]) => (
              <StatBar key={label} label={label} value={val || 0} color={color} />
            ))}
            {isDriver && c.mental !== undefined && (
              <div style={{ marginTop:4 }}>
                <StatBar label="Mental Strength" value={(c.mental || 0) * 10} max={100} color="#00C46A" />
                <div style={{ ...T.cap, fontSize:10, marginTop:-4 }}>{c.mental}/10</div>
              </div>
            )}
          </Card>
        )}

        {/* Identity & Profile */}
        <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
          {(c.bio || c.driving_style || c.strengths) && (
            <Card>
              <div style={{ ...T.cap, color:'#E8002D', marginBottom:8 }}>Profile</div>
              {c.bio && (
                <div style={{ ...T.sub, fontStyle:'italic', fontSize:13, marginBottom:8 }}>"{c.bio}"</div>
              )}
              {c.driving_style && (
                <div style={{ marginBottom:6 }}>
                  <span style={{ ...T.cap, color:'#55556A' }}>Style: </span>
                  <span style={{ ...T.body, fontSize:13 }}>{c.driving_style}</span>
                </div>
              )}
              {c.strengths && (
                <div style={{ marginBottom:6 }}>
                  <div style={{ ...T.cap, color:'#00C46A', marginBottom:3 }}>Strengths</div>
                  <div style={{ ...T.sub, fontSize:12 }}>{c.strengths}</div>
                </div>
              )}
              {c.weaknesses && (
                <div>
                  <div style={{ ...T.cap, color:'#E8002D', marginBottom:3 }}>Weaknesses</div>
                  <div style={{ ...T.sub, fontSize:12 }}>{c.weaknesses}</div>
                </div>
              )}
              {(c.good_tracks || c.bad_tracks) && (
                <div style={{ marginTop:10 }}>
                  {c.good_tracks && (
                    <div style={{ marginBottom:6 }}>
                      <div style={{ ...T.cap, color:'#00C46A', marginBottom:4 }}>Good Tracks</div>
                      <div style={{ display:'flex', flexWrap:'wrap', gap:4 }}>
                        {(Array.isArray(c.good_tracks) ? c.good_tracks : String(c.good_tracks).split(',')).map(s=>s.trim()).filter(Boolean).map(id => {
                          const t = TRACKS.find(x=>x.id===id||x.name.toLowerCase().includes(id.toLowerCase()));
                          return t ? (
                            <span key={id} style={{ ...T.cap, fontSize:11, padding:'2px 7px', borderRadius:12,
                              background:'#00C46A22', border:'1px solid #00C46A55', color:'#00C46A' }}>
                              {TRACK_FLAG[t.id]||''} {t.name.replace(' GP','')}
                            </span>
                          ) : null;
                        })}
                      </div>
                    </div>
                  )}
                  {c.bad_tracks && (
                    <div>
                      <div style={{ ...T.cap, color:'#E8002D', marginBottom:4 }}>Bad Tracks</div>
                      <div style={{ display:'flex', flexWrap:'wrap', gap:4 }}>
                        {(Array.isArray(c.bad_tracks) ? c.bad_tracks : String(c.bad_tracks).split(',')).map(s=>s.trim()).filter(Boolean).map(id => {
                          const t = TRACKS.find(x=>x.id===id||x.name.toLowerCase().includes(id.toLowerCase()));
                          return t ? (
                            <span key={id} style={{ ...T.cap, fontSize:11, padding:'2px 7px', borderRadius:12,
                              background:'#E8002D22', border:'1px solid #E8002D55', color:'#E8002D' }}>
                              {TRACK_FLAG[t.id]||''} {t.name.replace(' GP','')}
                            </span>
                          ) : null;
                        })}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </Card>
          )}
        </div>
      </div>

      {/* Backstory sections */}
      {(c.backstory || c.backstory_origin || c.backstory_journey || c.backstory_motivation) && (
        <div style={{ marginTop:16, display:'flex', flexDirection:'column', gap:14 }}>
          <div style={{ ...T.cap, color:'#E8002D' }}>Backstory</div>
          {c.backstory && (
            <Card>
              <div style={{ ...T.sub, fontSize:13, lineHeight:1.8 }}>{c.backstory}</div>
            </Card>
          )}
          {(c.backstory_origin || c.backstory_journey || c.backstory_motivation) && (
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:12 }}>
              {[
                ['Origin',     c.backstory_origin,     '#3B8EFF'],
                ['Journey',    c.backstory_journey,    '#FF9500'],
                ['Motivation', c.backstory_motivation, '#E8002D'],
              ].filter(([,v]) => v).map(([label, val, color]) => (
                <Card key={label}>
                  <div style={{ ...T.cap, color, marginBottom:6 }}>{label}</div>
                  <div style={{ ...T.sub, fontSize:12, lineHeight:1.7 }}>{val}</div>
                </Card>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Public image / paddock */}
      {(c.paddock_reputation || c.media_persona || c.paddock_relations) && (
        <div style={{ marginTop:16, display:'flex', flexDirection:'column', gap:14 }}>
          <div style={{ ...T.cap, color:'#55556A' }}>Public Image</div>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
            {c.media_persona && (
              <Card>
                <div style={{ ...T.cap, color:'#55556A', marginBottom:4 }}>Media Persona</div>
                <div style={{ ...T.sub, fontSize:12 }}>{c.media_persona}</div>
              </Card>
            )}
            {c.paddock_reputation && (
              <Card>
                <div style={{ ...T.cap, color:'#55556A', marginBottom:4 }}>Paddock Reputation</div>
                <div style={{ ...T.sub, fontSize:12 }}>{c.paddock_reputation}</div>
              </Card>
            )}
            {c.paddock_relations && (
              <Card style={{ gridColumn:'1/-1' }}>
                <div style={{ ...T.cap, color:'#55556A', marginBottom:4 }}>Paddock Relations</div>
                <div style={{ ...T.sub, fontSize:12, lineHeight:1.7 }}>{c.paddock_relations}</div>
              </Card>
            )}
          </div>
        </div>
      )}

      {!c.bio && !c.backstory && !c.backstory_origin && !c.paddock_reputation && !c.iconic_quote && !c.stat_roll_pending && (
        <Card style={{ marginTop:16 }}>
          <div style={{ ...T.sub }}>No biography added yet. Apply to the league to build out your character's full profile.</div>
        </Card>
      )}
    </div>
  );
}

// -- Track Picker (interactive good / bad track selector) ----------------------

function TrackPicker({ good, bad, onChange }) {
  const goodIds = (Array.isArray(good) ? good : (good||'').split(',')).map(s=>s.trim()).filter(Boolean);
  const badIds  = (Array.isArray(bad)  ? bad  : (bad ||'').split(',')).map(s=>s.trim()).filter(Boolean);

  function toggle(id, type) {
    const inGood = goodIds.includes(id);
    const inBad  = badIds.includes(id);
    let ng = [...goodIds], nb = [...badIds];
    if (type === 'good') {
      if (inGood) { ng = ng.filter(x=>x!==id); }
      else if (ng.length < 3) { ng.push(id); nb = nb.filter(x=>x!==id); }
    } else {
      if (inBad) { nb = nb.filter(x=>x!==id); }
      else if (nb.length < 3) { nb.push(id); ng = ng.filter(x=>x!==id); }
    }
    onChange(ng.join(','), nb.join(','));
  }

  function label(ids) {
    if (!ids.length) return 'None';
    return ids.map(id => { const t = TRACKS.find(t=>t.id===id); return t ? `${TRACK_FLAG[t.id]||''} ${t.name.replace(' GP','')}` : id; }).join('  ·  ');
  }

  return (
    <div>
      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(140px,1fr))', gap:6 }}>
        {TRACKS.map(t => {
          const isGood = goodIds.includes(t.id);
          const isBad  = badIds.includes(t.id);
          return (
            <div key={t.id}
              style={{ background:'#111114', border:`1px solid ${isGood?'#00C46A':isBad?'#E8002D':'#252530'}`,
                borderRadius:6, padding:'6px 8px' }}>
              <div style={{ ...T.cap, fontSize:11, marginBottom:5, whiteSpace:'nowrap', overflow:'hidden',
                textOverflow:'ellipsis', color: isGood?'#00C46A':isBad?'#E8002D':'#8888A0' }}>
                {TRACK_FLAG[t.id]||''} {t.name.replace(' GP','')}
              </div>
              <div style={{ display:'flex', gap:4 }}>
                {(['good','bad']).map(type => {
                  const active = type==='good' ? isGood : isBad;
                  const clr    = type==='good' ? '#00C46A' : '#E8002D';
                  const full   = type==='good' ? goodIds.length>=3 && !isGood : badIds.length>=3 && !isBad;
                  return (
                    <button key={type} onClick={() => !full && toggle(t.id, type)}
                      style={{ flex:1, padding:'2px 0', borderRadius:3, fontSize:9, fontFamily:FONT_BODY,
                        fontWeight:700, letterSpacing:1, cursor: full?'not-allowed':'pointer',
                        background: active ? clr+'22' : '#1A1A25',
                        border: `1px solid ${active ? clr : '#252530'}`,
                        color: active ? clr : full?'#333340':'#55556A',
                        opacity: full?0.5:1 }}>
                      {type.toUpperCase()}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
      <div style={{ display:'flex', gap:24, marginTop:10 }}>
        <div style={{ ...T.cap, color:'#00C46A', fontSize:11 }}>✓ Good: {label(goodIds)}</div>
        <div style={{ ...T.cap, color:'#E8002D', fontSize:11 }}>✗ Bad:  {label(badIds)}</div>
      </div>
    </div>
  );
}

// -- Character Edit Form ------------------------------------------------------

function CharacterEditForm({ char, onDone }) {
  const init = {
    photo_url: char.photo_url || '',
    nationality: char.nationality || '',
    dob: char.dob || '',
    height: char.height || '',
    weight: char.weight || '',
    driving_style: char.driving_style || '',
    strengths: char.strengths || '',
    weaknesses: char.weaknesses || '',
    good_tracks: char.good_tracks || '',
    bad_tracks: char.bad_tracks || '',
    preferred_conditions: char.preferred_conditions || '',
    personality: char.personality || '',
    media_persona: char.media_persona || '',
    paddock_reputation: char.paddock_reputation || '',
    paddock_relations: char.paddock_relations || '',
    backstory: char.backstory || '',
    backstory_origin: char.backstory_origin || '',
    backstory_journey: char.backstory_journey || '',
    iconic_quote: char.iconic_quote || '',
    ooc_notes: char.ooc_notes || '',
    sim_style: char.sim_style || '',
    mental: char.mental != null ? char.mental : 7,
  };
  const [fd, setFd] = useState(init);
  const [saving,        setSaving]        = useState(false);
  const [err,           setErr]           = useState('');
  const [photoUploading,setPhotoUploading]= useState(false);
  const [photoErr,      setPhotoErr]      = useState('');

  async function handlePhotoUpload(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setPhotoUploading(true); setPhotoErr('');
    const { url, error } = await uploadCharacterPhoto(file, char.id);
    setPhotoUploading(false);
    if (error) {
      setPhotoErr('Upload failed — ensure the character-photos bucket exists in Supabase Storage');
      return;
    }
    setFd(p => ({ ...p, photo_url: url }));
  }

  function set(k) { return e => setFd(p => ({ ...p, [k]: e.target.value })); }

  const iStyle = {
    width:'100%', background:'#111114', border:'1px solid #252530', borderRadius:6,
    color:'#F0F0F5', padding:'8px 10px', fontFamily:FONT_BODY, fontSize:13, boxSizing:'border-box',
  };

  function TF({ label, fkey, placeholder='' }) {
    return (
      <div style={{ marginBottom:14 }}>
        <label style={{ ...T.cap, color:'#8888A0', display:'block', marginBottom:4 }}>{label}</label>
        <input type="text" value={fd[fkey]} onChange={set(fkey)} placeholder={placeholder} style={iStyle} />
      </div>
    );
  }

  function TA({ label, fkey, rows=3, placeholder='' }) {
    return (
      <div style={{ marginBottom:14 }}>
        <label style={{ ...T.cap, color:'#8888A0', display:'block', marginBottom:4 }}>{label}</label>
        <textarea value={fd[fkey]} onChange={set(fkey)} rows={rows} placeholder={placeholder}
          style={{ ...iStyle, resize:'vertical' }} />
      </div>
    );
  }

  async function save() {
    setSaving(true); setErr('');
    const patch = {};
    Object.entries(fd).forEach(([k,v]) => { patch[k] = v || null; });
    patch.mental = Number(fd.mental) || null;

    // Try full patch first; if schema cache error strip the unknown column and retry
    let res = await sbFetch(`characters?id=eq.${char.id}`, { method:'PATCH', body:JSON.stringify(patch) });
    if (res.error && String(res.error).includes('Could not find')) {
      const missing = String(res.error).match(/'(\w+)' column/)?.[1];
      if (missing) {
        delete patch[missing];
        res = await sbFetch(`characters?id=eq.${char.id}`, { method:'PATCH', body:JSON.stringify(patch) });
      }
    }
    setSaving(false);
    if (res.error) { setErr(String(res.error)); return; }
    onDone({ ...char, ...patch });
  }

  return (
    <div style={{ maxWidth:760 }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:20 }}>
        <button onClick={() => onDone(null)}
          style={{ background:'none', border:'none', color:'#8888A0', cursor:'pointer',
            fontSize:14, fontFamily:FONT_BODY, display:'flex', alignItems:'center', gap:6, padding:0 }}>
          &lt; Cancel
        </button>
        <div style={{ ...T.cap, color:'#55556A' }}>Editing: {char.name}</div>
      </div>

      <Card style={{ marginBottom:16 }}>
        <div style={{ ...T.cap, color:'#E8002D', marginBottom:12 }}>Photo / Face Claim</div>
        <div style={{ display:'flex', gap:14, alignItems:'flex-start' }}>
          {fd.photo_url && (
            <img src={fd.photo_url} alt="preview"
              style={{ width:72, height:72, borderRadius:'50%', objectFit:'cover',
                border:'2px solid #E8002D', flexShrink:0 }}
              onError={e => { e.target.style.display='none'; }} />
          )}
          <div style={{ flex:1 }}>
            <label style={{ ...T.cap, color:'#8888A0', display:'block', marginBottom:6 }}>Upload Photo</label>
            <input type="file" accept="image/*"
              onChange={handlePhotoUpload}
              disabled={photoUploading}
              style={{ display:'block', marginBottom:8, fontSize:12, color:'#8888A0',
                fontFamily:FONT_BODY, cursor:'pointer', width:'100%' }} />
            {photoUploading && (
              <div style={{ ...T.cap, color:'#8888A0', marginBottom:8 }}>Uploading...</div>
            )}
            {photoErr && (
              <div style={{ color:'#E8002D', fontSize:12, marginBottom:8 }}>{photoErr}</div>
            )}
            <label style={{ ...T.cap, color:'#55556A', display:'block', marginBottom:4 }}>Or paste a URL</label>
            <input type="text" value={fd.photo_url||''} onChange={set('photo_url')}
              placeholder="https://i.imgur.com/..." style={iStyle} />
          </div>
        </div>
      </Card>

      <Card style={{ marginBottom:16 }}>
        <div style={{ ...T.cap, color:'#E8002D', marginBottom:12 }}>Personal Information</div>
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'0 20px' }}>
          <TF label="Nationality" fkey="nationality" />
          <TF label="Date of Birth" fkey="dob" placeholder="e.g. 1998-03-15" />
          <TF label="Height" fkey="height" placeholder="e.g. 180cm / 5'11&quot;" />
          <TF label="Weight" fkey="weight" placeholder="e.g. 68kg" />
        </div>
      </Card>

      <Card style={{ marginBottom:16 }}>
        <div style={{ ...T.cap, color:'#E8002D', marginBottom:12 }}>Simulator Style</div>
        <div style={{ ...T.cap, color:'#8888A0', marginBottom:8 }}>
          Pick your racing style — this directly affects your performance in the simulator
        </div>
        <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:6, marginBottom:14 }}>
          {DRIVING_STYLES.map(s => {
            const sel = fd.sim_style === s.id;
            return (
              <div key={s.id} onClick={() => setFd(p => ({ ...p, sim_style: s.id }))}
                style={{ padding:'8px 10px', borderRadius:6, cursor:'pointer', userSelect:'none',
                  background: sel ? (s.color||'#E8002D')+'22' : '#111114',
                  border: `1px solid ${sel ? (s.color||'#E8002D') : '#252530'}`,
                  transition:'border-color .12s, background .12s' }}>
                <div style={{ fontSize:16 }}>{STYLE_DISPLAY[s.id]?.icon || '🏎️'}</div>
                <div style={{ ...T.cap, color: sel ? (s.color||'#E8002D') : '#8888A0',
                  fontSize:11, marginTop:3, textTransform:'capitalize' }}>{STYLE_DISPLAY[s.id]?.label || s.id}</div>
              </div>
            );
          })}
        </div>
        {fd.sim_style && (() => {
          const s = DRIVING_STYLES.find(x => x.id === fd.sim_style);
          return s ? (
            <div style={{ padding:'10px 12px', borderRadius:6, background:(s.color||'#E8002D')+'11',
              border:`1px solid ${(s.color||'#E8002D')}33`, marginBottom:14 }}>
              <div style={{ ...T.cap, color: s.color||'#E8002D', marginBottom:4 }}>{s.name||s.id}</div>
              <div style={{ ...T.sub, color:'#8888A0', fontSize:12, lineHeight:1.5 }}>{STYLE_DISPLAY[fd.sim_style]?.tip || ''}</div>
            </div>
          ) : null;
        })()}
      </Card>

      <Card style={{ marginBottom:16 }}>
        <div style={{ ...T.cap, color:'#E8002D', marginBottom:12 }}>Good &amp; Bad Tracks</div>
        <div style={{ ...T.cap, color:'#8888A0', marginBottom:10, fontSize:11 }}>
          Select up to 3 circuits where your driver excels and 3 where they struggle (+3/-3 sim modifier each)
        </div>
        <TrackPicker
          good={fd.good_tracks} bad={fd.bad_tracks}
          onChange={(g,b) => setFd(p => ({ ...p, good_tracks:g, bad_tracks:b }))} />
      </Card>

      <Card style={{ marginBottom:16 }}>
        <div style={{ ...T.cap, color:'#E8002D', marginBottom:12 }}>Mental Strength</div>
        <div style={{ marginBottom:14 }}>
          <label style={{ ...T.cap, color:'#8888A0', display:'block', marginBottom:6 }}>
            Mental Strength — {fd.mental}/10
          </label>
          <input type="range" min={1} max={10} step={1} value={fd.mental}
            onChange={e => setFd(p => ({ ...p, mental: Number(e.target.value) }))}
            style={{ width:'100%', accentColor:'#E8002D' }} />
          <div style={{ display:'flex', justifyContent:'space-between', marginTop:4 }}>
            <span style={{ ...T.cap, fontSize:10, color:'#55556A' }}>1 — Crumbles under pressure</span>
            <span style={{ ...T.cap, fontSize:10, color:'#55556A' }}>10 — Unshakeable</span>
          </div>
        </div>
      </Card>

      <Card style={{ marginBottom:16 }}>
        <div style={{ ...T.cap, color:'#E8002D', marginBottom:12 }}>Driver Profile</div>
        <TF label="Driving Style (narrative description)" fkey="driving_style"
          placeholder="e.g. Aggressive late-braker who excels under pressure, maximises tyre life through long stints" />
        <TA label="Strengths" fkey="strengths" placeholder="e.g. Tyre management, wet conditions, overtaking" />
        <TA label="Weaknesses" fkey="weaknesses" placeholder="e.g. Single-lap qualifying pace, high-speed corners" />
        <TF label="Preferred Conditions" fkey="preferred_conditions" placeholder="e.g. Intermediate, overcast" />
        <TA label="Personality" fkey="personality" placeholder="Describe your character's on and off-track personality" />
        <TA label="Media Reputation" fkey="media_persona" placeholder="How the media portrays them publicly" />
        <TA label="Relationship With Teammates" fkey="paddock_reputation" placeholder="How they interact with teammates and rivals" />
      </Card>

      <Card style={{ marginBottom:16 }}>
        <div style={{ ...T.cap, color:'#E8002D', marginBottom:12 }}>Career History</div>
        <TA label="Karting Career" fkey="backstory_origin" rows={4} placeholder="Early karting background, championships, notable performances..." />
        <TA label="Junior Formulas (Road to F1)" fkey="backstory_journey" rows={4} placeholder="F3, F2, GP2 career, standout seasons..." />
      </Card>

      <Card style={{ marginBottom:16 }}>
        <div style={{ ...T.cap, color:'#E8002D', marginBottom:12 }}>Personal Backstory</div>
        <TA label="Personal Backstory (minimum 2 paragraphs)" fkey="backstory" rows={10}
          placeholder="Write at least two full paragraphs about your character's personal story and what drives them..." />
      </Card>

      <Card style={{ marginBottom:16 }}>
        <div style={{ ...T.cap, color:'#E8002D', marginBottom:12 }}>Public Image</div>
        <TA label="Public Image" fkey="paddock_relations" rows={4}
          placeholder="How the public and paddock see your character..." />
      </Card>

      <Card style={{ marginBottom:20 }}>
        <div style={{ ...T.cap, color:'#E8002D', marginBottom:12 }}>Quote & OOC</div>
        <TF label="Iconic Quote" fkey="iconic_quote" placeholder="A memorable quote from your character" />
        <TA label="OOC Notes (timezone, activity level, notes for admins)" fkey="ooc_notes" rows={3} />
      </Card>

      {err && <div style={{ color:'#E8002D', marginBottom:12, fontSize:13 }}>{err}</div>}
      <div style={{ display:'flex', gap:12, paddingBottom:32 }}>
        <Button onClick={save} disabled={saving}>{saving ? 'Saving...' : 'Save Profile'}</Button>
        <Button variant="secondary" onClick={() => onDone(null)}>Cancel</Button>
      </div>
    </div>
  );
}

// -- Characters Page ---------------------------------------------------------- ----------------------------------------------------------

function CharactersPage({ sbUser }) {
  const [chars, setChars] = useState(null);
  const [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [selected, setSelected] = useState(null);

  async function loadChars() {
    if (!sbClient) { setChars([]); setLoading(false); return; }
    const { data } = await sbFetch(`characters?owner_id=eq.${sbUser.id}&order=created_at.desc&select=*`);
    setChars(data || []);
    setLoading(false);
  }

  if (!loaded) { setLoaded(true); loadChars(); }
  if (loading) return <Spinner />;
  if (selected) return <CharacterDetail char={selected} onBack={() => setSelected(null)} sbUser={sbUser} />;

  if (creating) return (
    <CreateCharacterForm sbUser={sbUser}
      onDone={() => { setCreating(false); loadChars(); }}
      onCancel={() => setCreating(false)} />
  );

  return (
    <div>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:24 }}>
        <div>
          <div style={{ ...T.h1 }}>My Characters</div>
          <div style={{ ...T.sub }}>Your driver and staff characters</div>
        </div>
        <Button onClick={() => setCreating(true)}>+ New Character</Button>
      </div>
      {!chars || chars.length === 0 ? (
        <EmptyState title="No characters yet" sub="Create a driver or staff character to get started"
          action={<Button onClick={() => setCreating(true)}>Create Character</Button>} />
      ) : (
        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(300px,1fr))', gap:14 }}>
          {chars.map(c => (
            <Card key={c.id} onClick={() => setSelected(c)}>
              <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:12 }}>
                {c.photo_url ? (
                  <img src={c.photo_url} alt={c.name}
                    style={{ width:44, height:44, borderRadius:'50%', objectFit:'cover', flexShrink:0 }} />
                ) : (
                  <div style={{ width:44, height:44, borderRadius:'50%', background:'#252530',
                    display:'flex', alignItems:'center', justifyContent:'center',
                    fontSize:16, fontWeight:800, color:'#E8002D' }}>
                    {c.number || (c.name||'?')[0].toUpperCase()}
                  </div>
                )}
                <div style={{ flex:1 }}>
                  <div style={{ ...T.h3 }}>{c.name}</div>
                  <div style={{ ...T.sub }}>{c.type}{c.number ? ` - #${c.number}` : ''}</div>
                </div>
                {c.stat_roll_pending && <Badge color="#FFD700">Roll Stats</Badge>}
                <Badge color={c.is_active ? '#00C46A' : '#55556A'}>
                  {c.is_active ? 'Active' : 'Inactive'}
                </Badge>
              </div>
              {c.type === 'driver' && (
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'0 20px' }}>
                  <StatBar label="Pace"        value={c.pace}        color="#E8002D" />
                  <StatBar label="Consistency" value={c.consistency} color="#3B8EFF" />
                  <StatBar label="Wet"         value={c.wet}         color="#3B8EFF" />
                  <StatBar label="Overtaking"  value={c.overtaking}  color="#FF9500" />
                </div>
              )}
              {c.bio && <div style={{ ...T.sub, fontSize:12, marginTop:8, fontStyle:'italic' }}>"{c.bio}"</div>}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function CreateCharacterForm({ sbUser, onDone, onCancel }) {
  const [step, setStep] = useState(0);
  const [type, setType] = useState('driver');
  const [form, setForm] = useState({
    name:'', nationality:'', number:'', abbr:'', bio:'', backstory:'', photo_url:'',
    pace:70, consistency:70, wet:70, overtaking:70, defense:70, experience:50, mental:7,
    style:'balanced',
    technical:70, strategy_skill:70, leadership:70, morale:70,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  async function save() {
    if (!form.name.trim()) { setError('Name is required'); return; }
    setSaving(true);
    setError('');
    const payload = {
      owner_id: sbUser.id, type,
      name: form.name, nationality: form.nationality,
      bio: form.bio, backstory: form.backstory,
      photo_url: form.photo_url || null,
      ...(type === 'driver' ? {
        number: parseInt(form.number) || null, abbr: form.abbr,
        pace: form.pace, consistency: form.consistency, wet: form.wet,
        overtaking: form.overtaking, defense: form.defense,
        experience: form.experience, mental: form.mental, style: form.style,
      } : {
        technical: form.technical, strategy_skill: form.strategy_skill,
        leadership: form.leadership, morale: form.morale,
      }),
    };
    const { error: err } = await sbFetch('characters', {
      method:'POST', body: JSON.stringify(payload),
      headers:{ Prefer:'return=minimal' }
    });
    setSaving(false);
    if (err) { setError(err); return; }
    onDone();
  }

  const steps = type === 'driver'
    ? ['Type & Identity', 'Background', 'Stats']
    : ['Type & Identity', 'Background', 'Staff Stats'];

  return (
    <div style={{ maxWidth:600 }}>
      <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:24 }}>
        <button onClick={onCancel} style={{ background:'none', border:'none',
          color:'#8888A0', cursor:'pointer', fontSize:20, lineHeight:1 }}>{'<'}</button>
        <div>
          <div style={{ ...T.h1 }}>New Character</div>
          <div style={{ ...T.sub }}>Step {step+1} of {steps.length}: {steps[step]}</div>
        </div>
      </div>
      <div style={{ display:'flex', gap:6, marginBottom:24 }}>
        {steps.map((s, i) => (
          <div key={i} style={{ flex:1, height:4, borderRadius:2,
            background: i <= step ? '#E8002D' : '#252530', transition:'background .2s' }} />
        ))}
      </div>
      {error && <div style={{ background:'rgba(232,0,45,0.1)', border:'1px solid #E8002D', borderRadius:7,
        padding:'10px 14px', marginBottom:16, fontSize:13, color:'#E8002D' }}>{error}</div>}
      {step === 0 && (
        <Card>
          <Select label="Character Type" value={type} onChange={setType}
            options={[{ value:'driver', label:'Driver' }, { value:'mechanic', label:'Mechanic' },
              { value:'engineer', label:'Engineer' }, { value:'team_principal', label:'Team Principal' }]} />
          <Input label="Full Name" value={form.name} onChange={v => set('name',v)} placeholder="e.g. Alex Hendry" />
          <Input label="Photo URL (optional)" value={form.photo_url} onChange={v => set('photo_url',v)} placeholder="https://i.imgur.com/yourphoto.jpg" />
          <Input label="Nationality" value={form.nationality} onChange={v => set('nationality',v)} placeholder="e.g. British" />
          {type === 'driver' && <>
            <Input label="Race Number" value={form.number} onChange={v => set('number',v)} placeholder="1-99" />
            <Input label="Abbreviation (3 letters)" value={form.abbr} onChange={v => set('abbr',v)} placeholder="e.g. HEN" />
          </>}
        </Card>
      )}
      {step === 1 && (
        <Card>
          <Textarea label="Bio (shown publicly)" value={form.bio} onChange={v => set('bio',v)}
            placeholder="A few sentences about your character..." rows={3} />
          <Textarea label="Backstory" value={form.backstory} onChange={v => set('backstory',v)}
            placeholder="Their history, motivations, journey to F1..." rows={6} />
        </Card>
      )}
      {step === 2 && type === 'driver' && (
        <Card>
          <div style={{ ...T.sub, marginBottom:16, fontSize:12 }}>
            Note: Final stats are set by the GM. These are your proposed starting values.
          </div>
          <Select label="Driving Style" value={form.style} onChange={v => set('style',v)}
            options={[{ value:'aggressive', label:'Aggressive' }, { value:'smooth', label:'Smooth' },
              { value:'balanced', label:'Balanced' }, { value:'defensive', label:'Defensive' },
              { value:'wet_weather', label:'Wet Weather Specialist' }]} />
          {[['pace','Pace'],['consistency','Consistency'],['wet','Wet Skill'],
            ['overtaking','Overtaking'],['defense','Defense'],['experience','Experience']].map(([k,l]) => (
            <div key={k} style={{ marginBottom:14 }}>
              <div style={{ display:'flex', justifyContent:'space-between', marginBottom:4 }}>
                <span style={{ ...T.cap }}>{l}</span>
                <span style={{ fontSize:13, fontWeight:700, color:'#E8002D' }}>{form[k]}</span>
              </div>
              <input type="range" min={40} max={99} value={form[k]}
                onChange={e => set(k, parseInt(e.target.value))}
                style={{ width:'100%', accentColor:'#E8002D' }} />
            </div>
          ))}
          <div style={{ marginBottom:14 }}>
            <div style={{ display:'flex', justifyContent:'space-between', marginBottom:4 }}>
              <span style={{ ...T.cap }}>Mental Strength</span>
              <span style={{ fontSize:13, fontWeight:700, color:'#E8002D' }}>{form.mental}/10</span>
            </div>
            <input type="range" min={1} max={10} value={form.mental}
              onChange={e => set('mental', parseInt(e.target.value))}
              style={{ width:'100%', accentColor:'#E8002D' }} />
          </div>
        </Card>
      )}
      {step === 2 && type !== 'driver' && (
        <Card>
          <div style={{ ...T.sub, marginBottom:16, fontSize:12 }}>Proposed starting stats for your staff character.</div>
          {[['technical','Technical Skill'],['strategy_skill','Strategy'],
            ['leadership','Leadership'],['morale','Morale']].map(([k,l]) => (
            <div key={k} style={{ marginBottom:14 }}>
              <div style={{ display:'flex', justifyContent:'space-between', marginBottom:4 }}>
                <span style={{ ...T.cap }}>{l}</span>
                <span style={{ fontSize:13, fontWeight:700, color:'#3B8EFF' }}>{form[k]}</span>
              </div>
              <input type="range" min={40} max={99} value={form[k]}
                onChange={e => set(k, parseInt(e.target.value))}
                style={{ width:'100%', accentColor:'#3B8EFF' }} />
            </div>
          ))}
        </Card>
      )}
      <div style={{ display:'flex', gap:10, marginTop:16 }}>
        {step > 0 && <Button variant="secondary" onClick={() => setStep(s => s-1)}>Back</Button>}
        {step < steps.length-1
          ? <Button onClick={() => setStep(s => s+1)} style={{ flex:1 }}>Next</Button>
          : <Button onClick={save} disabled={saving} style={{ flex:1 }}>
              {saving ? 'Saving...' : 'Create Character'}
            </Button>}
      </div>
    </div>
  );
}

// -- Applications Page --------------------------------------------------------

function ApplyPage({ sbUser }) {
  const [apps, setApps] = useState(null);
  const [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);

  async function loadApps() {
    if (!sbClient) { setApps([]); setLoading(false); return; }
    const { data } = await sbFetch(
      `applications?applicant_id=eq.${sbUser.id}&order=created_at.desc` +
      `&select=*,characters(name,type),league_teams(name)`
    );
    setApps(data || []); setLoading(false);
  }

  if (!loaded) { setLoaded(true); loadApps(); }
  if (loading) return <Spinner />;

  if (creating) return (
    <ApplicationForm sbUser={sbUser}
      onDone={() => { setCreating(false); loadApps(); }}
      onCancel={() => setCreating(false)} />
  );

  return (
    <div>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:24 }}>
        <div>
          <div style={{ ...T.h1 }}>Applications</div>
          <div style={{ ...T.sub }}>Submit and track your character applications</div>
        </div>
        <Button onClick={() => setCreating(true)}>+ New Application</Button>
      </div>
      {!apps || apps.length === 0 ? (
        <EmptyState title="No applications yet" sub="Apply to join a team as a driver or staff member"
          action={<Button onClick={() => setCreating(true)}>Apply Now</Button>} />
      ) : (
        <div style={{ display:'flex', flexDirection:'column', gap:12 }}>
          {apps.map(app => (
            <Card key={app.id}>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start' }}>
                <div>
                  <div style={{ ...T.h3, marginBottom:4 }}>
                    {app.characters?.name}
                    <span style={{ ...T.sub, marginLeft:8 }}>({app.characters?.type})</span>
                  </div>
                  {app.league_teams && <div style={{ ...T.sub }}>Applying to: {app.league_teams.name}</div>}
                  <div style={{ ...T.cap, marginTop:4 }}>{new Date(app.created_at).toLocaleDateString()}</div>
                </div>
                <StatusBadge status={app.status} />
              </div>
              {app.revision_note && (
                <div style={{ marginTop:12, padding:'10px 12px', background:'rgba(255,149,0,0.1)',
                  border:'1px solid rgba(255,149,0,0.4)', borderRadius:7, fontSize:13, color:'#FF9500' }}>
                  <strong>Revision needed:</strong> {app.revision_note}
                </div>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function ApplicationForm({ sbUser, onDone, onCancel }) {
  const [teams,  setTeams]  = useState([]);
  const [step,   setStep]   = useState(0);
  const [saving, setSaving] = useState(false);
  const [error,  setError]  = useState('');
  const [loaded, setLoaded] = useState(false);
  const [fd, setFd] = useState({
    char_name:'', char_type:'driver', char_number:'', team_id:'',
    // section 2 — identity details
    nationality:'', age:'', height:'',
    // section 3 — driver profile / staff profile
    driving_style:'balanced', strengths:'', weaknesses:'', specialisation:'', work_style:'', known_for:'',
    // section 4 — career history
    career_background:'', career_path:'', achievements:'',
    // section 5 — backstory
    backstory_origin:'', backstory_journey:'', backstory_motivation:'',
    // section 6 driver — public image / staff — paddock relations
    paddock_reputation:'', media_persona:'professional', paddock_relations:'', personal_life:'',
    // section 7 — stats (driver)
    pace:70, consistency:70, wet:70, overtaking:70, defense:70, experience:50, mental:7,
    // section 8 — quote / ooc
    iconic_quote:'', ooc_notes:'',
  });
  const set = (k,v) => setFd(f => ({...f, [k]:v}));

  if (!loaded) {
    setLoaded(true);
    if (sbClient) {
      Promise.all([
        sbFetch('league_teams?select=id,name'),
        sbFetch('league_drivers?select=team_id,characters!character_id(type)&limit=500'),
      ]).then(([t,ld]) => {
        // Build slot map: teamId -> driver count
        const slotMap = {};
        (ld.data||[]).forEach(d => {
          const tid = d.team_id;
          if (!slotMap[tid]) slotMap[tid] = 0;
          if ((d.characters?.type || 'driver') === 'driver') slotMap[tid]++;
        });
        const teamsWithSlots = (t.data||[]).map(team => ({
          ...team,
          driversFull: (slotMap[team.id] || 0) >= 2,
        }));
        setTeams(teamsWithSlots);
      });
    }
  }

  const isDriver = fd.char_type === 'driver';

  const SECTIONS_DRIVER = [
    'Character & Team', 'Driver Details', 'Driver Profile',
    'Career History', 'Personal Backstory', 'Public Image',
    'Stat Requests', 'Quote & OOC',
  ];
  const SECTIONS_STAFF = [
    'Character & Team', 'Staff Details', 'Professional Profile',
    'Career History', 'Personal Backstory', 'Paddock Relations',
    'Quote & OOC',
  ];
  const sections = isDriver ? SECTIONS_DRIVER : SECTIONS_STAFF;
  const totalSteps = sections.length;

  async function submit() {
    setSaving(true); setError('');
    // Create the new character first
    const charRes = await sbFetch('characters', {
      method:'POST',
      headers:{ Prefer:'return=representation' },
      body: JSON.stringify({
        name: fd.char_name.trim(),
        type: fd.char_type,
        number: fd.char_number ? parseInt(fd.char_number, 10) : null,
        owner_id: sbUser.id,
        is_active: false,
      })
    });
    if (charRes.error) { setSaving(false); setError(charRes.error); return; }
    const newChar = Array.isArray(charRes.data) ? charRes.data[0] : charRes.data;
    if (!newChar?.id) { setSaving(false); setError('Failed to create character'); return; }
    const { error: err } = await sbFetch('applications', {
      method:'POST',
      body: JSON.stringify({
        character_id: newChar.id,
        applicant_id: sbUser.id,
        desired_team_id: fd.team_id || null,
        status: 'submitted',
        submitted_at: new Date().toISOString(),
        form_data: fd,
      })
    });
    setSaving(false);
    if (err) { setError(err); return; }
    onDone();
  }

  function nextStep() {
    if (step === 0 && !fd.char_name.trim()) { setError('Please enter a character name'); return; }
    setError('');
    if (step < totalSteps - 1) setStep(s => s+1);
    else submit();
  }

  return (
    <div style={{ maxWidth:640 }}>
      {/* Header */}
      <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:20 }}>
        <button onClick={onCancel} style={{ background:'none', border:'none',
          color:'#8888A0', cursor:'pointer', fontSize:14, fontFamily:FONT_BODY, padding:0 }}>
          &lt; Cancel
        </button>
        <div style={{ flex:1 }}>
          <div style={{ ...T.cap, color:'#E8002D', marginBottom:2 }}>
            Section {step+1} of {totalSteps}
          </div>
          <div style={{ ...T.h2 }}>{sections[step]}</div>
        </div>
      </div>

      {/* Progress bar */}
      <div style={{ display:'flex', gap:4, marginBottom:24 }}>
        {sections.map((_, i) => (
          <div key={i} style={{ flex:1, height:3, borderRadius:2, cursor:'pointer',
            background: i <= step ? '#E8002D' : '#252530', transition:'background .2s' }}
            onClick={() => i < step && setStep(i)} />
        ))}
      </div>

      {error && (
        <div style={{ background:'rgba(232,0,45,0.1)', border:'1px solid #E8002D',
          borderRadius:7, padding:'10px 14px', marginBottom:16, fontSize:13, color:'#E8002D' }}>
          {error}
        </div>
      )}

      {/* Section 0 — New Character & Team */}
      {step === 0 && (
        <Card>
          <Input label="Character Name" value={fd.char_name} onChange={v => set('char_name',v)}
            placeholder="Enter your character's full name" />
          <Select label="Role" value={fd.char_type} onChange={v => set('char_type',v)}
            options={[
              { value:'driver',           label:'Driver' },
              { value:'team_principal',   label:'Team Principal' },
              { value:'race_engineer',    label:'Race Engineer' },
              { value:'engineer',         label:'Engineer' },
            ]} />
          {isDriver && (
            <Input label="Car Number (optional)" value={fd.char_number} onChange={v => set('char_number',v)}
              placeholder="e.g. 44" />
          )}
          <Select label="Desired Team (optional)" value={fd.team_id} onChange={v => set('team_id',v)}
            options={[{ value:'', label:'No preference' },
              ...teams.map(t => ({
                value: t.id,
                label: t.driversFull ? `${t.name} (Full)` : t.name,
                disabled: t.driversFull,
              }))]} />
          {fd.team_id && teams.find(t => t.id === fd.team_id)?.driversFull && (
            <div style={{ fontSize:12, color:'#FF9500', marginTop:-8, marginBottom:8 }}>
              This team's driver slots are currently full.
            </div>
          )}
          <div style={{ ...T.sub, fontSize:12 }}>
            Create a new character for this application. If you have no team preference, leave the team blank.
          </div>
        </Card>
      )}

      {/* Section 1 — Details */}
      {step === 1 && (
        <Card>
          <Input label="Nationality" value={fd.nationality} onChange={v => set('nationality',v)}
            placeholder="e.g. British" />
          <Input label="Age" value={fd.age} onChange={v => set('age',v)} placeholder="e.g. 24" />
          <Input label="Height" value={fd.height} onChange={v => set('height',v)} placeholder="e.g. 182cm" />
        </Card>
      )}

      {/* Section 2 — Driver Profile / Staff Professional Profile */}
      {step === 2 && isDriver && (
        <Card>
          <Select label="Driving Style" value={fd.driving_style} onChange={v => set('driving_style',v)}
            options={[
              { value:'aggressive',   label:'Aggressive' },
              { value:'smooth',       label:'Smooth' },
              { value:'balanced',     label:'Balanced' },
              { value:'defensive',    label:'Defensive' },
              { value:'wet_weather',  label:'Wet Weather Specialist' },
            ]} />
          <Textarea label="Strengths" value={fd.strengths} onChange={v => set('strengths',v)} rows={3}
            placeholder="What is this driver naturally gifted at? Racecraft, overtaking, tyre management..." />
          <Textarea label="Weaknesses" value={fd.weaknesses} onChange={v => set('weaknesses',v)} rows={3}
            placeholder="Where does this driver struggle? Areas for development..." />
        </Card>
      )}
      {step === 2 && !isDriver && (
        <Card>
          <Input label="Specialisation" value={fd.specialisation} onChange={v => set('specialisation',v)}
            placeholder="e.g. Aerodynamics, Strategy, Engine development..." />
          <Textarea label="Working Style" value={fd.work_style} onChange={v => set('work_style',v)} rows={3}
            placeholder="How does this person approach their work? Methodical, creative, under pressure..." />
          <Textarea label="Known For" value={fd.known_for} onChange={v => set('known_for',v)} rows={3}
            placeholder="What achievements or qualities is this person recognised for?" />
        </Card>
      )}

      {/* Section 3 — Career History */}
      {step === 3 && (
        <Card>
          <Textarea label="Racing / Professional Background" value={fd.career_background}
            onChange={v => set('career_background',v)} rows={4}
            placeholder={isDriver
              ? "Where did this driver race before F1? Junior formulae, GP2, Formula 2..."
              : "What organisations or teams has this person worked for previously?"} />
          <Textarea label="Career Path" value={fd.career_path}
            onChange={v => set('career_path',v)} rows={4}
            placeholder={isDriver
              ? "How did this driver progress to Formula One? Key moments, turning points..."
              : "How did they reach their current role? Key milestones in their career..."} />
          <Textarea label="Notable Achievements" value={fd.achievements}
            onChange={v => set('achievements',v)} rows={3}
            placeholder="Championships, records, standout performances, awards..." />
        </Card>
      )}

      {/* Section 4 — Personal Backstory */}
      {step === 4 && (
        <Card>
          <Textarea label="Origin Story" value={fd.backstory_origin}
            onChange={v => set('backstory_origin',v)} rows={4}
            placeholder="Where is this character from? Family background, early life, what shaped them..." />
          <Textarea label="Journey to F1 / This Role" value={fd.backstory_journey}
            onChange={v => set('backstory_journey',v)} rows={4}
            placeholder="What obstacles did they overcome? Who helped them along the way?" />
          <Textarea label="Personal Motivations" value={fd.backstory_motivation}
            onChange={v => set('backstory_motivation',v)} rows={3}
            placeholder="What drives this character? What are they trying to prove or achieve?" />
        </Card>
      )}

      {/* Section 5 — Public Image (driver) / Paddock Relations (staff) */}
      {step === 5 && isDriver && (
        <Card>
          <Select label="Media Persona" value={fd.media_persona} onChange={v => set('media_persona',v)}
            options={[
              { value:'professional',  label:'Professional and reserved' },
              { value:'charismatic',   label:'Charismatic and outgoing' },
              { value:'controversial', label:'Controversial and outspoken' },
              { value:'private',       label:'Private and quiet' },
              { value:'fan_favourite', label:'Fan favourite' },
            ]} />
          <Textarea label="Reputation in the Paddock" value={fd.paddock_reputation}
            onChange={v => set('paddock_reputation',v)} rows={3}
            placeholder="How do other drivers, teams and media view this person?" />
          <Textarea label="Key Relationships" value={fd.paddock_relations}
            onChange={v => set('paddock_relations',v)} rows={4}
            placeholder="Teammates, rivals, mentors, friends, enemies — relationships that define this character..." />
        </Card>
      )}
      {step === 5 && !isDriver && (
        <Card>
          <Textarea label="Personal Life" value={fd.personal_life}
            onChange={v => set('personal_life',v)} rows={4}
            placeholder="Family, interests outside work, lifestyle, what matters to them beyond racing..." />
          <Textarea label="Paddock Relationships" value={fd.paddock_relations}
            onChange={v => set('paddock_relations',v)} rows={4}
            placeholder="Key professional relationships — drivers they work closely with, rivalries, friendships..." />
        </Card>
      )}

      {/* Section 6 — Stat Requests (driver only, otherwise this is step 6 = Quote) */}
      {step === 6 && isDriver && (
        <Card>
          <div style={{ ...T.sub, fontSize:12, marginBottom:16 }}>
            These are your proposed starting stats. The GM will review and set your final values.
          </div>
          {[
            ['pace',        'Raw Pace',       '#E8002D'],
            ['consistency', 'Consistency',    '#3B8EFF'],
            ['wet',         'Wet Skill',      '#3B8EFF'],
            ['overtaking',  'Overtaking',     '#FF9500'],
            ['defense',     'Defense',        '#FF9500'],
            ['experience',  'Experience',     '#55556A'],
          ].map(([k,l,c]) => (
            <div key={k} style={{ marginBottom:14 }}>
              <div style={{ display:'flex', justifyContent:'space-between', marginBottom:4 }}>
                <span style={{ ...T.cap }}>{l}</span>
                <span style={{ fontSize:13, fontWeight:700, color:c }}>{fd[k]}</span>
              </div>
              <input type="range" min={40} max={99} value={fd[k]}
                onChange={e => set(k, parseInt(e.target.value))}
                style={{ width:'100%', accentColor:c }} />
            </div>
          ))}
          <div style={{ marginBottom:14 }}>
            <div style={{ display:'flex', justifyContent:'space-between', marginBottom:4 }}>
              <span style={{ ...T.cap }}>Mental Strength</span>
              <span style={{ fontSize:13, fontWeight:700, color:'#00C46A' }}>{fd.mental}/10</span>
            </div>
            <input type="range" min={1} max={10} value={fd.mental}
              onChange={e => set('mental', parseInt(e.target.value))}
              style={{ width:'100%', accentColor:'#00C46A' }} />
          </div>
        </Card>
      )}

      {/* Section — Quote & OOC (last section for both types) */}
      {((step === 7 && isDriver) || (step === 6 && !isDriver)) && (
        <Card>
          <Input label="Iconic Quote" value={fd.iconic_quote} onChange={v => set('iconic_quote',v)}
            placeholder="A defining quote that captures this character's voice..." />
          <Textarea label="OOC Notes to GM" value={fd.ooc_notes} onChange={v => set('ooc_notes',v)} rows={5}
            placeholder="Out-of-character notes — anything you want the GM to know. Character intentions, stat reasoning, roleplay goals..." />
        </Card>
      )}

      {/* Navigation */}
      <div style={{ display:'flex', gap:10, marginTop:20 }}>
        {step > 0 && (
          <Button variant="secondary" onClick={() => setStep(s => s-1)}>Back</Button>
        )}
        <Button onClick={nextStep} disabled={saving} style={{ flex:1 }}>
          {saving ? 'Submitting...' : step < totalSteps-1 ? `Next: ${sections[step+1]}` : 'Submit Application'}
        </Button>
      </div>
    </div>
  );
}

// -- My Team Page ------------------------------------------------------------

function MyTeamPage({ sbUser }) {
  const [data,    setData]    = useState(null);
  const [loading, setLoading] = useState(true);
  const [loaded,  setLoaded]  = useState(false);

  if (!loaded) {
    setLoaded(true);
    if (!sbClient || !sbUser) { setLoading(false); setData(null); return; }
    // 1. get player's characters
    sbFetch(`characters?owner_id=eq.${sbUser.id}&select=id,name,type`)
      .then(({ data: chars }) => {
        if (!chars || chars.length === 0) { setLoading(false); return; }
        const ids = chars.map(c => c.id).join(',');
        // 2. find which character is in league_drivers
        sbFetch(`league_drivers?character_id=in.(${ids})&select=*,league_teams(*)`)
          .then(({ data: drivers }) => {
            if (!drivers || drivers.length === 0) { setLoading(false); return; }
            // use first assignment
            const assignment = drivers[0];
            const team = assignment.league_teams;
            if (!team) { setLoading(false); return; }
            // 3. get full team roster
            sbFetch(`league_drivers?team_id=eq.${team.id}&select=*,characters(name,type,is_active,pace,consistency)`)
              .then(({ data: roster }) => {
                setData({ team, assignment, roster: roster || [], myChars: chars });
                setLoading(false);
              });
          });
      });
  }

  if (loading) return <Spinner />;

  if (!data || !data.team) {
    return (
      <div>
        <div style={{ ...T.cap, color:'#E8002D', marginBottom:6 }}>Player Portal</div>
        <div style={{ ...T.h1, marginBottom:16 }}>My Team</div>
        <EmptyState
          title="Not assigned to a team yet"
          sub="Once the GM approves your application and assigns you to a team, your team page will appear here."
          action={null} />
      </div>
    );
  }

  const { team, assignment, roster } = data;
  const drivers  = roster.filter(r => r.characters?.type === 'driver');
  const staff    = roster.filter(r => r.characters?.type !== 'driver');

  return (
    <div>
      <div style={{ ...T.cap, color:'#E8002D', marginBottom:6 }}>Player Portal</div>

      {/* Team header */}
      <div style={{ display:'flex', alignItems:'center', gap:16, marginBottom:28 }}>
        <div style={{ width:6, height:60, background: team.color || '#E8002D', borderRadius:3, flexShrink:0 }} />
        <div>
          <div style={{ ...T.h1, marginBottom:4 }}>{team.name}</div>
          <div style={{ ...T.sub }}>{team.tier ? `${team.tier} tier` : 'Formula One'}</div>
        </div>
      </div>

      {/* Car stat tiles */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:12, marginBottom:28 }}>
        {[['Car Pace',team.car_pace],['Reliability',team.reliability],
          ['Pit Speed',team.pit_speed],['Tyre Life',team.tyre_life]].map(([l,v]) => (
          <Card key={l} style={{ textAlign:'center', padding:'14px 10px' }}>
            <div style={{ fontSize:28, fontWeight:900, fontFamily:FONT_HEAD,
              color: team.color || '#E8002D' }}>{v || '--'}</div>
            <div style={{ ...T.cap }}>{l}</div>
          </Card>
        ))}
      </div>

      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:20 }}>

        {/* Drivers */}
        <div>
          <div style={{ ...T.h2, marginBottom:14 }}>Drivers</div>
          {drivers.length === 0 ? (
            <div style={{ ...T.sub }}>No drivers assigned yet</div>
          ) : (
            <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
              {drivers.map(d => (
                <Card key={d.id}>
                  <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:10 }}>
                    <div style={{ width:40, height:40, borderRadius:'50%',
                      background:(team.color||'#E8002D')+'22',
                      display:'flex', alignItems:'center', justifyContent:'center',
                      fontSize:14, fontWeight:800, color: team.color||'#E8002D', fontFamily:FONT_HEAD }}>
                      {d.number || (d.characters?.name||'?')[0].toUpperCase()}
                    </div>
                    <div style={{ flex:1 }}>
                      <div style={{ ...T.h3 }}>{d.characters?.name || d.name || 'Driver'}</div>
                      <Badge color={d.characters?.is_active ? '#00C46A' : '#55556A'}>
                        {d.characters?.is_active ? 'Active' : 'Reserve'}
                      </Badge>
                    </div>
                  </div>
                  <StatBar label="Pace"        value={d.characters?.pace||0}        color={team.color||'#E8002D'} />
                  <StatBar label="Consistency" value={d.characters?.consistency||0} color={team.color||'#E8002D'} />
                </Card>
              ))}
            </div>
          )}
        </div>

        {/* Staff */}
        <div>
          <div style={{ ...T.h2, marginBottom:14 }}>Staff</div>
          {staff.length === 0 ? (
            <div style={{ ...T.sub }}>No staff assigned yet</div>
          ) : (
            <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
              {staff.map(s => (
                <Card key={s.id}>
                  <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                    <div style={{ width:36, height:36, borderRadius:'50%', background:'#252530',
                      display:'flex', alignItems:'center', justifyContent:'center',
                      fontSize:13, fontWeight:700, color:'#8888A0' }}>
                      {(s.characters?.name||'?')[0].toUpperCase()}
                    </div>
                    <div>
                      <div style={{ ...T.h3 }}>{s.characters?.name || s.name || 'Staff'}</div>
                      <div style={{ ...T.cap }}>{s.characters?.type || 'staff'}</div>
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// -- Teams Page ---------------------------------------------------------------

function TeamsPage() {
  const [teams,    setTeams]    = useState(null);
  const [selected, setSelected] = useState(null);
  const [loading,  setLoading]  = useState(true);
  const [loaded,   setLoaded]   = useState(false);

  if (!loaded) {
    setLoaded(true);
    if (sbClient) {
      sbFetch('league_teams?select=*&order=name')
        .then(({ data }) => { setTeams(data && data.length ? data : null); setLoading(false); });
    } else { setLoading(false); }
  }

  if (loading) return <Spinner />;

  if (selected) return <TeamDetail team={selected} onBack={() => setSelected(null)} />;

  const displayTeams = teams || TEAMS.map(t => ({
    id: t.id, name: t.name, color: t.color, tier: t.tier,
    car_pace: t.carPace, reliability: t.reliability, pit_speed: t.pitSpeed,
    tyre_life: t.tyreLife, strategy: t.strategy,
  }));

  return (
    <div>
      <div style={{ ...T.h1, marginBottom:8 }}>Teams</div>
      <div style={{ ...T.sub, marginBottom:24 }}>Click any team to see their full roster and stats</div>
      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(260px,1fr))', gap:14 }}>
        {displayTeams.map(t => (
          <Card key={t.id} onClick={() => setSelected(t)}>
            <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:12 }}>
              <div style={{ width:5, height:44, background: t.color || '#E8002D', borderRadius:3 }} />
              <div style={{ flex:1 }}>
                <div style={{ ...T.h3 }}>{t.name}</div>
                <div style={{ ...T.cap, color:'#55556A', textTransform:'capitalize' }}>{(t.tier||'').replace('_',' ')} tier</div>
              </div>
              <div style={{ fontSize:18, opacity:.4 }}>›</div>
            </div>
            <StatBar label="Car Pace"    value={t.car_pace || t.carPace || 75}    color={t.color || '#E8002D'} />
            <StatBar label="Reliability" value={t.reliability || 75}              color={t.color || '#E8002D'} />
            <StatBar label="Pit Speed"   value={t.pit_speed || t.pitSpeed || 70}  color={t.color || '#E8002D'} />
          </Card>
        ))}
      </div>
    </div>
  );
}

function TeamDetail({ team, onBack }) {
  const [staff,    setStaff]    = useState(null);
  const [teamWins, setTeamWins] = useState(null);
  const [loaded,   setLoaded]   = useState(false);

  if (!loaded) {
    setLoaded(true);
    const isDbTeam = !!sbClient && !!team.id;
    if (isDbTeam) {
      Promise.all([
        sbFetch(`characters?team_id=eq.${team.id}&is_active=eq.true&select=*&order=type`),
        sbFetch(`session_runs?status=eq.final&session=eq.race&select=result`),
      ]).then(([cr, sr]) => {
        const chars = cr.data || [];
        setStaff(chars);
        const myNames = new Set(chars.map(c => c.name));
        let wins = 0, podiums = 0;
        (sr.data || []).forEach(s => {
          (s.result?.placements || []).slice(0, 3).forEach((p, pos) => {
            const n = p.driver || p.name || '';
            if (myNames.has(n)) { if (pos === 0) wins++; podiums++; }
          });
        });
        setTeamWins({ wins, podiums });
      });
    } else {
      setStaff([]);
      setTeamWins({ wins: 0, podiums: 0 });
    }
  }

  const drivers   = (staff || []).filter(c => c.type === 'driver');
  const principal = (staff || []).find(c => c.type === 'team_principal');
  const engineers = (staff || []).filter(c => c.type === 'race_engineer');
  const others    = (staff || []).filter(c => !['driver','team_principal','race_engineer'].includes(c.type));
  const tc        = team.color || '#E8002D';

  function StaffAvatar({ person, size=48 }) {
    return person.photo_url ? (
      <img src={person.photo_url} alt={person.name}
        style={{ width:size, height:size, borderRadius:'50%', objectFit:'cover',
          border:`2px solid ${tc}`, flexShrink:0 }} />
    ) : (
      <div style={{ width:size, height:size, borderRadius:'50%', background:tc+'33', flexShrink:0,
        display:'flex', alignItems:'center', justifyContent:'center',
        fontSize:size*0.4, fontWeight:700, color:tc, fontFamily:FONT_HEAD }}>
        {person.number || (person.name||'?')[0].toUpperCase()}
      </div>
    );
  }

  return (
    <div>
      <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:24 }}>
        <button onClick={onBack} style={{ background:'none', border:'none', color:'#8888A0', cursor:'pointer', fontSize:20 }}>{'<'}</button>
        <div style={{ width:6, height:48, background:tc, borderRadius:3 }} />
        <div>
          <div style={{ ...T.h1 }}>{team.name}</div>
          <div style={{ ...T.sub }}>{team.tier} tier</div>
        </div>
      </div>

      {/* Car stats */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(110px,1fr))', gap:10, marginBottom:20 }}>
        {[['Car Pace', team.car_pace || team.carPace],
          ['Reliability', team.reliability],
          ['Pit Speed', team.pit_speed || team.pitSpeed],
          ['Tyre Life', team.tyre_life || team.tyreLife],
          ['Strategy', team.strategy_skill || team.strategy]].map(([l,v]) => v != null ? (
          <Card key={l} style={{ textAlign:'center', padding:'12px 8px' }}>
            <div style={{ fontSize:26, fontWeight:900, color:tc, fontFamily:FONT_HEAD, lineHeight:1 }}>
              {typeof v === 'number' ? v : '—'}
            </div>
            <div style={{ ...T.cap, fontSize:11, marginTop:4 }}>{l}</div>
          </Card>
        ) : null).filter(Boolean)}
      </div>

      {/* Win stats */}
      {teamWins && (
        <div style={{ display:'grid', gridTemplateColumns:'repeat(2,1fr)', gap:12, marginBottom:24 }}>
          {[['Race Wins', teamWins.wins, '#FFD700'], ['Podiums', teamWins.podiums, '#C0C0C0']].map(([l,v,clr]) => (
            <Card key={l} style={{ textAlign:'center', padding:14 }}>
              <div style={{ fontSize:36, fontWeight:900, color:clr, fontFamily:FONT_HEAD }}>{v}</div>
              <div style={{ ...T.cap }}>{l}</div>
            </Card>
          ))}
        </div>
      )}

      {/* Drivers */}
      <div style={{ ...T.h2, marginBottom:14 }}>Drivers</div>
      {staff === null ? <Spinner /> : drivers.length === 0 ? (
        <div style={{ marginBottom:24 }}>
          <EmptyState title="No drivers assigned" sub="Check back after the GM assigns seats" />
        </div>
      ) : (
        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(260px,1fr))', gap:12, marginBottom:24 }}>
          {drivers.map(d => (
            <Card key={d.id}>
              <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:10 }}>
                <StaffAvatar person={d} size={40} />
                <div>
                  <div style={{ ...T.h3 }}>{d.name}</div>
                  {d.number && <div style={{ ...T.cap, color:'#55556A' }}>#{d.number}</div>}
                </div>
              </div>
              <div style={{ display:'flex', gap:6, flexWrap:'wrap', marginBottom:8 }}>
                {d.nationality && <Badge color="#3B8EFF">{d.nationality}</Badge>}
                {(d.sim_style || d.driving_style) && (() => {
                  const s = DRIVING_STYLES.find(x => x.id === (d.sim_style || d.style));
                  return <Badge color={s ? (s.color||'#FF9500') : '#FF9500'}>
                    {s ? (s.icon ? s.icon+' '+s.id : s.id) : (d.driving_style||d.style)}
                  </Badge>;
                })()}
              </div>
              <StatBar label="Pace"        value={d.pace}        color={tc} />
              <StatBar label="Consistency" value={d.consistency} color={tc} />
              <StatBar label="Wet"         value={d.wet}         color={tc} />
              <StatBar label="Overtaking"  value={d.overtaking}  color={tc} />
              {d.mental != null && (
                <div style={{ ...T.cap, color:'#8888A0', fontSize:11, marginTop:6 }}>
                  Mental: {d.mental}/10
                </div>
              )}
            </Card>
          ))}
        </div>
      )}

      {/* Team Principal */}
      {principal && (
        <div style={{ marginBottom:20 }}>
          <div style={{ ...T.h2, marginBottom:12 }}>Team Principal</div>
          <Card>
            <div style={{ display:'flex', alignItems:'center', gap:14 }}>
              <StaffAvatar person={principal} size={52} />
              <div>
                <div style={{ ...T.h3 }}>{principal.name}</div>
                <div style={{ ...T.cap, color:'#55556A' }}>Team Principal</div>
                {principal.nationality && <div style={{ ...T.cap, color:'#8888A0', fontSize:11, marginTop:3 }}>{principal.nationality}</div>}
              </div>
            </div>
          </Card>
        </div>
      )}

      {/* Race Engineers */}
      {engineers.length > 0 && (
        <div style={{ marginBottom:20 }}>
          <div style={{ ...T.h2, marginBottom:12 }}>Race Engineers</div>
          <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(220px,1fr))', gap:12 }}>
            {engineers.map(e => (
              <Card key={e.id}>
                <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:8 }}>
                  <StaffAvatar person={e} size={36} />
                  <div>
                    <div style={{ ...T.h3 }}>{e.name}</div>
                    <div style={{ ...T.cap, color:'#55556A' }}>Race Engineer</div>
                  </div>
                </div>
                {e.nationality && <div style={{ ...T.cap, color:'#8888A0', fontSize:11, marginBottom:6 }}>{e.nationality}</div>}
                {e.technical !== undefined && <StatBar label="Technical" value={e.technical} color="#3B8EFF" />}
                {e.strategy_skill !== undefined && <StatBar label="Strategy"  value={e.strategy_skill} color="#FF9500" />}
              </Card>
            ))}
          </div>
        </div>
      )}

      {/* Other staff */}
      {others.length > 0 && (
        <div style={{ marginBottom:20 }}>
          <div style={{ ...T.h2, marginBottom:12 }}>Other Staff</div>
          <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(220px,1fr))', gap:12 }}>
            {others.map(s => (
              <Card key={s.id}>
                <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                  <StaffAvatar person={s} size={36} />
                  <div>
                    <div style={{ ...T.h3 }}>{s.name}</div>
                    <div style={{ ...T.cap, color:'#55556A' }}>{(s.type||'').replace(/_/g,' ')}</div>
                    {s.nationality && <div style={{ ...T.cap, color:'#8888A0', fontSize:11 }}>{s.nationality}</div>}
                  </div>
                </div>
              </Card>
            ))}
          </div>
        </div>
      )}

      {staff !== null && staff.length === 0 && (
        <EmptyState title="No staff assigned" sub="Drivers and staff will appear here once assigned by the GM" />
      )}
    </div>
  );
}

// -- Championship Page --------------------------------------------------------

function ChampionshipPage({ profile }) {
  const [standings, setStandings] = useState(null);
  const [teams,     setTeams]     = useState([]);
  const [rounds,    setRounds]    = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [loaded,    setLoaded]    = useState(false);
  const [tab,       setTab]       = useState('drivers');

  if (!loaded) {
    setLoaded(true);
    if (sbClient) {
      Promise.all([
        sbFetch('standings?order=driver_points.desc&limit=50'),
        sbFetch('league_teams?order=name&select=*'),
        sbFetch('rounds?select=id,state&order=number'),
      ]).then(([s, t, r]) => {
        setStandings(s.data || []);
        setTeams(t.data || []);
        setRounds(r.data || []);
        setLoading(false);
      });
    } else { setLoading(false); setStandings([]); }
  }

  if (loading) return <Spinner />;

  const complete = (rounds||[]).filter(r => r.state === 'complete').length;
  const total    = (rounds||[]).length;

  // Constructor standings: sum driver_points grouped by team
  const ctorMap = {};
  (standings||[]).forEach(s => {
    const key = s.team_name || 'Unknown';
    if (!ctorMap[key]) {
      const t = teams.find(t => t.name === key);
      ctorMap[key] = { name:key, points:0, color:t?.color||'#55556A', drivers:[] };
    }
    ctorMap[key].points += s.driver_points || 0;
    ctorMap[key].drivers.push(s.driver_name);
  });
  const ctorRows = Object.values(ctorMap).sort((a,b) => b.points - a.points);

  const leader = standings?.[0];
  const medalColor = i => i === 0 ? '#FFD700' : i === 1 ? '#C0C0C0' : i === 2 ? '#CD7F32' : '#55556A';

  const teamColor = name => {
    const t = teams.find(t => t.name === name);
    return t?.color || '#55556A';
  };

  if (!standings || standings.length === 0) {
    return (
      <div>
        <div style={{ ...T.cap, color:'#E8002D', marginBottom:4 }}>Formula One</div>
        <div style={{ ...T.h1, marginBottom:8 }}>Championship</div>
        <EmptyState title="No standings yet"
          sub="Race results will appear here once the season begins" />
      </div>
    );
  }

  return (
    <div>
      {/* Season header */}
      <div style={{ ...T.cap, color:'#E8002D', marginBottom:4 }}>Formula One</div>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:24 }}>
        <div>
          <div style={{ ...T.h1, marginBottom:4 }}>Championship</div>
          {total > 0 && (
            <div style={{ ...T.sub }}>
              {complete}/{total} rounds complete
            </div>
          )}
        </div>
        {leader && (
          <div style={{ textAlign:'right' }}>
            <div style={{ ...T.cap, marginBottom:2 }}>Drivers Leader</div>
            <div style={{ ...T.h2 }}>{leader.driver_name}</div>
            <div style={{ fontSize:28, fontWeight:900, color:'#FFD700', fontFamily:FONT_HEAD, lineHeight:1 }}>
              {leader.driver_points} pts
            </div>
            {standings[1] && (
              <div style={{ ...T.sub, fontSize:12 }}>
                +{(leader.driver_points||0) - (standings[1].driver_points||0)} over {standings[1].driver_name}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Tabs */}
      <div style={{ display:'flex', gap:4, marginBottom:20 }}>
        {[['drivers','Drivers'],['constructors','Constructors']].map(([id,label]) => (
          <button key={id} onClick={() => setTab(id)}
            style={{ padding:'8px 18px', border:'none', borderRadius:6, fontSize:13, fontWeight:600,
              cursor:'pointer', background: tab === id ? '#E8002D' : '#111114',
              color: tab === id ? '#fff' : '#8888A0', fontFamily:FONT_BODY }}>
            {label}
          </button>
        ))}
      </div>

      {/* Driver standings */}
      {tab === 'drivers' && (
        <Card style={{ padding:0, overflow:'hidden' }}>
          <div style={{ display:'grid', gridTemplateColumns:'48px 1fr 160px 60px',
            padding:'10px 16px', background:'#111114', borderBottom:'1px solid #252530' }}>
            {['Pos','Driver','Team','Pts'].map(h =>
              <span key={h} style={{ ...T.cap }}>{h}</span>)}
          </div>
          {standings.map((s, i) => (
            <div key={s.driver_id||i} style={{
              display:'grid', gridTemplateColumns:'48px 1fr 160px 60px',
              padding:'12px 16px',
              borderBottom: i < standings.length-1 ? '1px solid #252530' : 'none',
              alignItems:'center',
              background: i === 0 ? '#FFD70008' : 'transparent' }}>
              <div style={{ fontWeight:900, fontSize:16, color:medalColor(i), fontFamily:FONT_HEAD }}>{i+1}</div>
              <div>
                <div style={{ ...T.body, fontWeight:600 }}>{s.driver_name}</div>
                {s.driver_number && <div style={{ ...T.cap }}>#{s.driver_number}</div>}
              </div>
              <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                <div style={{ width:4, height:16, borderRadius:2, background:teamColor(s.team_name) }} />
                <span style={{ ...T.sub }}>{s.team_name}</span>
              </div>
              <div style={{ fontWeight:900, fontSize:16, color:medalColor(i), fontFamily:FONT_HEAD }}>
                {s.driver_points}
              </div>
            </div>
          ))}
        </Card>
      )}

      {/* Constructor standings */}
      {tab === 'constructors' && (
        <Card style={{ padding:0, overflow:'hidden' }}>
          <div style={{ display:'grid', gridTemplateColumns:'48px 1fr 1fr 60px',
            padding:'10px 16px', background:'#111114', borderBottom:'1px solid #252530' }}>
            {['Pos','Constructor','Drivers','Pts'].map(h =>
              <span key={h} style={{ ...T.cap }}>{h}</span>)}
          </div>
          {ctorRows.map((c, i) => (
            <div key={c.name} style={{
              display:'grid', gridTemplateColumns:'48px 1fr 1fr 60px',
              padding:'12px 16px',
              borderBottom: i < ctorRows.length-1 ? '1px solid #252530' : 'none',
              alignItems:'center' }}>
              <div style={{ fontWeight:900, fontSize:16, color:medalColor(i), fontFamily:FONT_HEAD }}>{i+1}</div>
              <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                <div style={{ width:4, height:28, borderRadius:2, background:c.color }} />
                <div style={{ ...T.body, fontWeight:600 }}>{c.name}</div>
              </div>
              <div style={{ ...T.sub, fontSize:12 }}>{c.drivers.join(', ')}</div>
              <div style={{ fontWeight:900, fontSize:16, color:medalColor(i), fontFamily:FONT_HEAD }}>
                {c.points}
              </div>
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}

// -- Round Detail -------------------------------------------------------------

function RoundDetail({ round, onBack }) {
  const [sessions, setSessions] = useState(null);
  const [loading,  setLoading]  = useState(true);
  const [loaded,   setLoaded]   = useState(false);

  if (!loaded) {
    setLoaded(true);
    if (sbClient) {
      sbFetch(`session_runs?round_id=eq.${round.id}&select=*&order=session`).then(({ data }) => {
        setSessions(data || []);
        setLoading(false);
      });
    } else { setLoading(false); setSessions([]); }
  }

  if (loading) return <Spinner />;

  const qual        = (sessions||[]).find(s => s.session === 'qualifying' && s.status === 'final');
  const race        = (sessions||[]).find(s => s.session === 'race'      && s.status === 'final');
  const qualGrid    = qual?.result?.placements || qual?.result?.grid || [];
  const racePlaces  = race?.result?.placements || [];
  const fastest     = race?.result?.fastestLap;
  const F1_PTS      = [25,18,15,12,10,8,6,4,2,1];
  const medalColor  = i => i === 0 ? '#FFD700' : i === 1 ? '#C0C0C0' : i === 2 ? '#CD7F32' : '#55556A';

  return (
    <div>
      <button onClick={onBack}
        style={{ background:'none', border:'none', color:'#8888A0', cursor:'pointer',
          fontSize:14, fontFamily:FONT_BODY, display:'flex', alignItems:'center', gap:6,
          marginBottom:20, padding:0 }}>
        &lt; Back to Calendar
      </button>

      <div style={{ ...T.cap, color:'#E8002D', marginBottom:4 }}>Round {round.number}</div>
      <div style={{ ...T.h1, marginBottom:4 }}>{round.circuit_name || round.circuit_id}</div>
      <div style={{ ...T.sub, marginBottom:24, display:'flex', alignItems:'center', gap:8 }}>
        {round.scheduled_for ? new Date(round.scheduled_for).toDateString() : 'Date unknown'}
        {round.is_sprint && <Badge color="#FF9500">Sprint</Badge>}
        <Badge color="#00C46A">Complete</Badge>
      </div>

      {/* Race Results */}
      {racePlaces.length > 0 ? (
        <div style={{ marginBottom:28 }}>
          <div style={{ ...T.h2, marginBottom:14 }}>Race Results</div>
          {fastest && (
            <div style={{ marginBottom:12, display:'flex', alignItems:'center', gap:8 }}>
              <Badge color="#E8002D">Fastest Lap</Badge>
              <span style={{ ...T.body, fontSize:13 }}>{fastest.driver || fastest.name}</span>
              {fastest.time && <span style={{ ...T.cap, color:'#8888A0' }}>{fastest.time}</span>}
            </div>
          )}
          <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
            {racePlaces.map((p, i) => {
              const name = p.driver || p.name || `Driver ${i+1}`;
              const pts  = i < 10 ? F1_PTS[i] : 0;
              return (
                <Card key={i} style={{ display:'flex', alignItems:'center', gap:14,
                  borderLeft:`3px solid ${medalColor(i)}` }}>
                  <div style={{ minWidth:32, fontWeight:900, fontSize:18,
                    color:medalColor(i), fontFamily:FONT_HEAD }}>
                    {i + 1}
                  </div>
                  <div style={{ flex:1 }}>
                    <div style={{ ...T.h3 }}>{name}</div>
                    {(p.team || p.teamName) && (
                      <div style={{ ...T.cap, color:'#55556A' }}>{p.team || p.teamName}</div>
                    )}
                  </div>
                  {pts > 0 && (
                    <div style={{ ...T.cap, color:'#E8002D', fontSize:13, fontWeight:700 }}>+{pts} pts</div>
                  )}
                  {p.gap && <div style={{ ...T.cap, color:'#55556A' }}>{p.gap}</div>}
                </Card>
              );
            })}
          </div>
        </div>
      ) : (
        <EmptyState title="No race results" sub="Results will appear once the race has been run" />
      )}

      {/* Qualifying Grid */}
      {qualGrid.length > 0 && (
        <div style={{ marginBottom:24 }}>
          <div style={{ ...T.h2, marginBottom:14 }}>Qualifying Grid</div>
          <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
            {qualGrid.map((p, i) => {
              const name = p.driver || p.name || `Driver ${i+1}`;
              return (
                <Card key={i} style={{ display:'flex', alignItems:'center', gap:14 }}>
                  <div style={{ minWidth:36, fontWeight:900, fontSize:16,
                    color: i === 0 ? '#E8002D' : '#55556A', fontFamily:FONT_HEAD }}>
                    P{i + 1}
                  </div>
                  <div style={{ flex:1 }}>
                    <div style={{ ...T.h3 }}>{name}</div>
                    {(p.team || p.teamName) && (
                      <div style={{ ...T.cap, color:'#55556A' }}>{p.team || p.teamName}</div>
                    )}
                  </div>
                  {p.time && <div style={{ ...T.cap, color:'#8888A0' }}>{p.time}</div>}
                </Card>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// -- Calendar Page ------------------------------------------------------------

function CalendarPage({ profile }) {
  const [rounds,    setRounds]    = useState(null);
  const [loading,   setLoading]   = useState(true);
  const [loaded,    setLoaded]    = useState(false);
  const [advancing, setAdvancing] = useState(null);
  const [selected,  setSelected]  = useState(null);

  async function load() {
    const { data } = await sbFetch('rounds?order=number&select=*');
    setRounds(data || []);
    setLoading(false);
  }

  if (!loaded) { setLoaded(true); if (sbClient) load(); else { setLoading(false); setRounds([]); } }
  if (selected) return <RoundDetail round={selected} onBack={() => setSelected(null)} />;
  if (loading) return <Spinner />;

  const isGM = profile?.role === 'gm' || profile?.role === 'admin';

  const STATE_PIPELINE = ['scheduled','orders_open','locked','in_progress','complete'];
  const STATE_LABEL    = { scheduled:'Scheduled', orders_open:'Orders Open', locked:'Locked',
    in_progress:'In Progress', complete:'Complete' };
  const STATE_COLOR    = { scheduled:'#55556A', orders_open:'#3B8EFF', locked:'#FF9500',
    in_progress:'#E8002D', complete:'#00C46A' };

  function nextState(s) {
    const i = STATE_PIPELINE.indexOf(s);
    return i >= 0 && i < STATE_PIPELINE.length-1 ? STATE_PIPELINE[i+1] : null;
  }

  async function advanceState(round) {
    const next = nextState(round.state);
    if (!next) return;
    setAdvancing(round.id);
    await sbFetch(`rounds?id=eq.${round.id}`, {
      method:'PATCH', body: JSON.stringify({ state: next })
    });
    setAdvancing(null);
    load();
  }

  if (!rounds || rounds.length === 0) {
    return (
      <div>
        <div style={{ ...T.cap, color:'#E8002D', marginBottom:4 }}>Season</div>
        <div style={{ ...T.h1, marginBottom:8 }}>Race Calendar</div>
        <div style={{ ...T.sub, marginBottom:24 }}>No season schedule set - circuit list</div>
        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(260px,1fr))', gap:12 }}>
          {TRACKS.map((t, i) => (
            <Card key={t.id}>
              <div style={{ display:'flex', gap:10 }}>
                <div style={{ minWidth:28, fontWeight:800, color:'#55556A', paddingTop:2 }}>{i+1}</div>
                <div>
                  <div style={{ ...T.h3 }}>{t.name}</div>
                  <div style={{ ...T.sub }}>{t.country}</div>
                  {t.hasSprint && <Badge color="#FF9500" style={{ marginTop:4 }}>Sprint</Badge>}
                </div>
              </div>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  const testingRounds = rounds.filter(r => r.number < 0).sort((a,b) => a.number - b.number);
  const raceRounds    = rounds.filter(r => r.number >= 1);
  const complete      = raceRounds.filter(r => r.state === 'complete').length;
  const nextRound     = raceRounds.find(r => r.state !== 'complete');

  return (
    <div>
      <div style={{ ...T.cap, color:'#E8002D', marginBottom:4 }}>Season</div>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:24 }}>
        <div>
          <div style={{ ...T.h1, marginBottom:4 }}>Race Calendar</div>
          <div style={{ ...T.sub }}>{complete}/{raceRounds.length} rounds complete
            {testingRounds.length > 0 && <span style={{ marginLeft:10, color:'#55556A' }}>+{testingRounds.length} testing</span>}
          </div>
        </div>
      </div>

      {/* Next round spotlight */}
      {nextRound && (
        <div style={{ marginBottom:24, padding:20, borderRadius:10,
          background:'linear-gradient(135deg,#1A1A25,#111114)',
          border:`1px solid ${STATE_COLOR[nextRound.state]}44` }}>
          <div style={{ ...T.cap, color:STATE_COLOR[nextRound.state], marginBottom:6 }}>
            {nextRound.state === 'in_progress' ? 'NOW RACING' : 'NEXT ROUND'}
          </div>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start' }}>
            <div>
              <div style={{ ...T.h1, marginBottom:4 }}>
                R{nextRound.number} &mdash; {nextRound.circuit_name || nextRound.circuit_id}
              </div>
              <div style={{ ...T.sub }}>
                {nextRound.scheduled_for ? new Date(nextRound.scheduled_for).toDateString() : 'Date TBD'}
                {nextRound.is_sprint && <span style={{ marginLeft:8 }}><Badge color="#FF9500">Sprint</Badge></span>}
              </div>
            </div>
            <Badge color={STATE_COLOR[nextRound.state]} style={{ fontSize:12 }}>
              {STATE_LABEL[nextRound.state]}
            </Badge>
          </div>

          {/* State pipeline */}
          <div style={{ display:'flex', alignItems:'center', gap:0, marginTop:16 }}>
            {STATE_PIPELINE.map((s, i) => {
              const done   = STATE_PIPELINE.indexOf(nextRound.state) > i;
              const active = nextRound.state === s;
              const color  = done ? '#00C46A' : active ? STATE_COLOR[s] : '#252530';
              return (
                <React.Fragment key={s}>
                  <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:4 }}>
                    <div style={{ width:12, height:12, borderRadius:'50%', background:color,
                      boxShadow: active ? `0 0 8px ${color}` : 'none', transition:'all .3s' }} />
                    <div style={{ ...T.cap, fontSize:9, color:active?color:'#55556A', whiteSpace:'nowrap' }}>
                      {STATE_LABEL[s].split(' ')[0]}
                    </div>
                  </div>
                  {i < STATE_PIPELINE.length-1 && (
                    <div style={{ flex:1, height:2, background:done?'#00C46A':'#252530',
                      transition:'background .3s', margin:'0 4px', marginBottom:16 }} />
                  )}
                </React.Fragment>
              );
            })}
          </div>

          {/* GM advance button */}
          {isGM && nextState(nextRound.state) && (
            <div style={{ marginTop:12 }}>
              <Button size="sm" onClick={() => advanceState(nextRound)}
                disabled={advancing === nextRound.id}>
                {advancing === nextRound.id
                  ? 'Advancing...'
                  : `Advance to: ${STATE_LABEL[nextState(nextRound.state)]}`}
              </Button>
            </div>
          )}
        </div>
      )}

      {/* Pre-Season Testing */}
      {testingRounds.length > 0 && (
        <div style={{ marginBottom:20 }}>
          <div style={{ ...T.cap, color:'#3B8EFF', marginBottom:10 }}>Pre-Season Testing</div>
          <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
            {testingRounds.map((r, idx) => {
              const sc = STATE_COLOR[r.state] || '#3B8EFF';
              const done = r.state === 'complete';
              return (
                <Card key={r.id}
                  onClick={done ? () => setSelected(r) : undefined}
                  style={{ cursor: done ? 'pointer' : 'default',
                    borderLeft:`3px solid ${done ? '#00C46A' : '#3B8EFF'}` }}>
                  <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                    <div style={{ display:'flex', gap:14, alignItems:'center' }}>
                      <div style={{ fontWeight:900, fontSize:16, color:done?'#00C46A':'#3B8EFF',
                        minWidth:52, fontFamily:FONT_HEAD }}>TEST {idx+1}</div>
                      <div>
                        <div style={{ ...T.h3 }}>{r.circuit_name || r.circuit_id}</div>
                        <div style={{ ...T.sub, fontSize:12 }}>
                          {r.scheduled_for ? new Date(r.scheduled_for).toDateString() : 'TBD'}
                        </div>
                      </div>
                    </div>
                    <div style={{ display:'flex', gap:8, alignItems:'center' }}>
                      <Badge color={sc}>{STATE_LABEL[r.state]||r.state}</Badge>
                      {done && <span style={{ ...T.cap, fontSize:10, color:'#00C46A' }}>View Results ›</span>}
                      {isGM && !done && nextState(r.state) && (
                        <Button size="sm" variant="secondary"
                          onClick={e => { e.stopPropagation(); advanceState(r); }}
                          disabled={advancing === r.id}>
                          {advancing === r.id ? '...' : 'Advance'}
                        </Button>
                      )}
                    </div>
                  </div>
                </Card>
              );
            })}
          </div>
        </div>
      )}

      {/* Full schedule */}
      <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
        {raceRounds.map(r => {
          const sc = STATE_COLOR[r.state] || '#55556A';
          const done = r.state === 'complete';
          return (
            <Card key={r.id}
              onClick={done ? () => setSelected(r) : undefined}
              style={{ cursor: done ? 'pointer' : 'default',
                borderLeft:`3px solid ${done ? '#00C46A' : sc}`,
                transition:'opacity .15s' }}>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                <div style={{ display:'flex', gap:14, alignItems:'center' }}>
                  <div style={{ fontWeight:900, fontSize:18, color:done?'#00C46A':'#55556A',
                    minWidth:36, fontFamily:FONT_HEAD }}>R{r.number}</div>
                  <div>
                    <div style={{ ...T.h3 }}>{r.circuit_name || r.circuit_id}</div>
                    <div style={{ ...T.sub, fontSize:12 }}>
                      {r.scheduled_for ? new Date(r.scheduled_for).toDateString() : 'TBD'}
                    </div>
                  </div>
                </div>
                <div style={{ display:'flex', gap:8, alignItems:'center' }}>
                  {r.is_sprint && <Badge color="#FF9500">Sprint</Badge>}
                  <Badge color={sc}>{STATE_LABEL[r.state]||r.state}</Badge>
                  {done && <span style={{ ...T.cap, fontSize:10, color:'#00C46A' }}>View Results ›</span>}
                  {isGM && !done && nextState(r.state) && (
                    <Button size="sm" variant="secondary"
                      onClick={() => advanceState(r)}
                      disabled={advancing === r.id}>
                      {advancing === r.id ? '...' : 'Advance'}
                    </Button>
                  )}
                </div>
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

// -- Statistics Page ----------------------------------------------------------

function StatsPage({ sbUser }) {
  const [sessions, setSessions] = useState(null);
  const [myChars,  setMyChars]  = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [loaded,   setLoaded]   = useState(false);
  const [tab,      setTab]      = useState('results');

  if (!loaded) {
    setLoaded(true);
    if (sbClient) {
      Promise.all([
        sbFetch('session_runs?order=created_at.desc&limit=100&select=*'),
        sbUser ? sbFetch(`characters?owner_id=eq.${sbUser.id}&select=*`) : Promise.resolve({ data:[] }),
      ]).then(([sr, cr]) => {
        setSessions(sr.data||[]);
        setMyChars(cr.data||[]);
        setLoading(false);
      });
    } else setLoading(false);
  }

  if (loading) return <Spinner />;

  // Tally wins and podiums from final race session_runs
  const finalRace = (sessions||[]).filter(s => s.status === 'final' && s.session === 'race');
  const winsMap   = {};
  finalRace.forEach(s => {
    (s.result?.placements || []).slice(0,3).forEach((p, pos) => {
      const name = p.driver || p.name || '';
      if (!name) return;
      if (!winsMap[name]) winsMap[name] = { name, wins:0, podiums:0, races:0, bestFinish:99 };
      if (pos === 0) winsMap[name].wins++;
      winsMap[name].podiums++;
    });
  });
  // Count appearances
  finalRace.forEach(s => {
    (s.result?.placements || []).forEach((p, pos) => {
      const name = p.driver || p.name || '';
      if (!name) return;
      if (!winsMap[name]) winsMap[name] = { name, wins:0, podiums:0, races:0, bestFinish:99 };
      winsMap[name].races++;
      if (pos + 1 < winsMap[name].bestFinish) winsMap[name].bestFinish = pos + 1;
    });
  });
  const winRows = Object.values(winsMap).sort((a,b) => b.wins - a.wins || b.podiums - a.podiums);

  // Build per-character career stats for my characters
  function charCareer(char) {
    const name = char.name;
    let appearances = 0, wins = 0, podiums = 0, bestFinish = 99, totalPoints = 0;
    const F1_PTS = [25,18,15,12,10,8,6,4,2,1];
    finalRace.forEach(s => {
      (s.result?.placements||[]).forEach((p, pos) => {
        const pname = p.driver || p.name || '';
        if (pname !== name) return;
        appearances++;
        if (pos === 0) wins++;
        if (pos < 3) podiums++;
        if (pos + 1 < bestFinish) bestFinish = pos + 1;
        totalPoints += F1_PTS[pos] || 0;
      });
    });
    return { appearances, wins, podiums, bestFinish: bestFinish === 99 ? '-' : `P${bestFinish}`, points: totalPoints };
  }

  return (
    <div>
      <div style={{ ...T.cap, color:'#E8002D', marginBottom:4 }}>Season Data</div>
      <div style={{ ...T.h1, marginBottom:24 }}>Statistics</div>

      <div style={{ display:'flex', gap:4, marginBottom:20 }}>
        {[['results','Race Results'],['wins','Wins Table'],['my','My Career']].map(([id,label]) => (
          <button key={id} onClick={() => setTab(id)}
            style={{ padding:'8px 18px', border:'none', borderRadius:6, fontSize:13, fontWeight:600,
              cursor:'pointer', background: tab === id ? '#E8002D' : '#111114',
              color: tab === id ? '#fff' : '#8888A0', fontFamily:FONT_BODY }}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'results' && (
        <div>
          {(!sessions || sessions.length === 0) && (
            <EmptyState title="No results yet"
              sub="Race and qualifying results will appear here once sessions are confirmed" />
          )}
          <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
            {(sessions||[]).map((s, i) => (
              <Card key={s.id||i}>
                <div style={{ display:'flex', justifyContent:'space-between', marginBottom:8 }}>
                  <div>
                    <div style={{ ...T.h3 }}>
                      {s.session === 'qualifying' ? 'Qualifying' : 'Race'}
                    </div>
                    <div style={{ ...T.sub, fontSize:12 }}>
                      {new Date(s.created_at||Date.now()).toLocaleString()}
                      <span style={{ marginLeft:8 }}>{s.run_count}x simulations</span>
                      {s.league_mode && <span style={{ marginLeft:8, color:'#3B8EFF' }}>League</span>}
                    </div>
                  </div>
                  <Badge color={s.status==='final'?'#00C46A':s.status==='provisional'?'#FF9500':'#55556A'}>
                    {s.status}
                  </Badge>
                </div>
                {s.result?.placements && (
                  <div style={{ display:'flex', flexDirection:'column', gap:3 }}>
                    {s.result.placements.slice(0,5).map((p,pi) => (
                      <div key={pi} style={{ display:'flex', gap:10, fontSize:12, alignItems:'center' }}>
                        <span style={{ fontWeight:900, color:pi<3?['#FFD700','#C0C0C0','#CD7F32'][pi]:'#55556A',
                          width:28, fontFamily:FONT_HEAD }}>P{pi+1}</span>
                        <span style={{ ...T.body }}>{p.driver||p.name||''}</span>
                        <span style={{ ...T.sub }}>{p.time||p.lapTime||p.teamId||''}</span>
                      </div>
                    ))}
                    {s.result.placements.length > 5 && (
                      <div style={{ ...T.cap, color:'#55556A' }}>+ {s.result.placements.length - 5} more</div>
                    )}
                  </div>
                )}
              </Card>
            ))}
          </div>
        </div>
      )}

      {tab === 'wins' && (
        <div>
          {winRows.length === 0 ? (
            <EmptyState title="No final results yet"
              sub="Wins and podiums are tallied from confirmed race results" />
          ) : (
            <Card style={{ padding:0, overflow:'hidden' }}>
              <div style={{ display:'grid', gridTemplateColumns:'48px 1fr 70px 80px 80px 80px',
                padding:'10px 16px', background:'#111114', borderBottom:'1px solid #252530' }}>
                {['Pos','Driver','Races','Wins','Podiums','Best'].map(h =>
                  <span key={h} style={{ ...T.cap }}>{h}</span>)}
              </div>
              {winRows.map((r, i) => (
                <div key={r.name} style={{
                  display:'grid', gridTemplateColumns:'48px 1fr 70px 80px 80px 80px',
                  padding:'12px 16px',
                  borderBottom: i < winRows.length-1 ? '1px solid #252530' : 'none',
                  alignItems:'center' }}>
                  <div style={{ fontWeight:900, fontSize:14, fontFamily:FONT_HEAD,
                    color: i<3?['#FFD700','#C0C0C0','#CD7F32'][i]:'#55556A' }}>{i+1}</div>
                  <div style={{ ...T.body, fontWeight:600 }}>{r.name}</div>
                  <div style={{ ...T.sub }}>{r.races}</div>
                  <div style={{ fontWeight:900, fontSize:16, color:'#FFD700', fontFamily:FONT_HEAD }}>{r.wins}</div>
                  <div style={{ fontWeight:700, fontSize:14 }}>{r.podiums}</div>
                  <div style={{ ...T.sub }}>P{r.bestFinish}</div>
                </div>
              ))}
            </Card>
          )}
        </div>
      )}

      {tab === 'my' && (
        <div>
          {(!myChars || myChars.length === 0) ? (
            <EmptyState title="No characters yet"
              sub="Create a character to track your career statistics" />
          ) : (
            <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
              {myChars.map(c => {
                const career = charCareer(c);
                const isDriver = c.type === 'driver';
                return (
                  <Card key={c.id}>
                    {/* Character header */}
                    <div style={{ display:'flex', alignItems:'center', gap:14, marginBottom:16 }}>
                      <div style={{ width:50, height:50, borderRadius:'50%', background:'#252530',
                        display:'flex', alignItems:'center', justifyContent:'center',
                        fontSize:18, fontWeight:900, color:'#E8002D', fontFamily:FONT_HEAD }}>
                        {c.number || (c.name||'?')[0].toUpperCase()}
                      </div>
                      <div style={{ flex:1 }}>
                        <div style={{ ...T.h2, marginBottom:2 }}>{c.name}</div>
                        <div style={{ display:'flex', gap:6 }}>
                          <Badge color="#3B8EFF">{c.type}</Badge>
                          {c.nationality && <Badge color="#55556A">{c.nationality}</Badge>}
                          <Badge color={c.is_active ? '#00C46A' : '#55556A'}>
                            {c.is_active ? 'Active' : 'Inactive'}
                          </Badge>
                        </div>
                      </div>
                    </div>

                    {/* Career stat tiles */}
                    <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:10, marginBottom:16 }}>
                      {[
                        ['Races', career.appearances, '#F0F0F5'],
                        ['Wins',  career.wins,         '#FFD700'],
                        ['Podiums',career.podiums,     '#E8002D'],
                        ['Best',  career.bestFinish,   '#3B8EFF'],
                      ].map(([l,v,c]) => (
                        <div key={l} style={{ background:'#111114', borderRadius:8, padding:'10px 12px',
                          textAlign:'center' }}>
                          <div style={{ fontSize:22, fontWeight:900, color:c,
                            fontFamily:FONT_HEAD, lineHeight:1 }}>{v}</div>
                          <div style={{ ...T.cap, marginTop:4 }}>{l}</div>
                        </div>
                      ))}
                    </div>

                    {/* Driver stat bars */}
                    {isDriver && (c.pace || c.consistency) && (
                      <div>
                        <div style={{ ...T.cap, color:'#E8002D', marginBottom:8 }}>Driver Stats</div>
                        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'0 20px' }}>
                          {[['Pace',c.pace,'#E8002D'],['Consistency',c.consistency,'#3B8EFF'],
                            ['Wet',c.wet,'#3B8EFF'],['Overtaking',c.overtaking,'#FF9500'],
                            ['Defense',c.defense,'#FF9500'],['Experience',c.experience,'#55556A']
                          ].map(([label,val,color]) => val ? (
                            <div key={label} style={{ marginBottom:8 }}>
                              <div style={{ display:'flex', justifyContent:'space-between', marginBottom:3 }}>
                                <span style={{ ...T.cap }}>{label}</span>
                                <span style={{ fontSize:12, fontWeight:700, color }}>{val}</span>
                              </div>
                              <div style={{ height:3, background:'#252530', borderRadius:2 }}>
                                <div style={{ height:'100%', background:color, borderRadius:2,
                                  width:`${val}%` }} />
                              </div>
                            </div>
                          ) : null)}
                        </div>
                      </div>
                    )}
                  </Card>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

async function sendNotification(recipientId, kind, payload) {
  if (!recipientId || !sbClient) return;
  try {
    await sbFetch('notifications', {
      method:'POST',
      body: JSON.stringify({ recipient_id: recipientId, kind, payload, read_at: null })
    });
  } catch(e) { /* non-fatal */ }
}

// -- Search Page -------------------------------------------------------------

function SearchPage({ setPage, setNavTarget }) {
  const [query,   setQuery]   = useState('');
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);

  async function doSearch(q) {
    if (!q || q.trim().length < 2) { setResults(null); return; }
    setLoading(true);
    const enc = encodeURIComponent(`%${q.trim()}%`);
    const [chars, profiles, teams, news] = await Promise.all([
      sbFetch(`characters?name=ilike.${enc}&select=id,name,type,is_active,nationality&limit=10`),
      sbFetch(`profiles?or=(username.ilike.${enc},display_name.ilike.${enc})&select=id,username,display_name,bio&limit=10`),
      sbFetch(`league_teams?name=ilike.${enc}&select=id,name,color,tier&limit=10`),
      sbFetch(`news_posts?title=ilike.${enc}&select=id,title,category,created_at&limit=5`),
    ]);
    setResults({
      characters: chars.data || [],
      profiles:   profiles.data || [],
      teams:      teams.data || [],
      news:       news.data || [],
    });
    setLoading(false);
  }

  function goProfile(profileId) {
    setNavTarget({ profileId });
    setPage('profile');
  }
  function goTeams() { setPage('teams'); }

  const total = results ? (results.characters.length + results.profiles.length +
    results.teams.length + results.news.length) : 0;

  return (
    <div>
      <div style={{ ...T.cap, color:'#E8002D', marginBottom:4 }}>League</div>
      <div style={{ ...T.h1, marginBottom:20 }}>Search</div>

      {/* Search input */}
      <div style={{ position:'relative', marginBottom:24 }}>
        <input
          type="text"
          value={query}
          onChange={e => { setQuery(e.target.value); doSearch(e.target.value); }}
          placeholder="Search characters, players, teams, news..."
          autoFocus
          style={{
            width:'100%', padding:'14px 44px 14px 16px', boxSizing:'border-box',
            background:'#111114', border:'1px solid #252530', borderRadius:8,
            color:'#F0F0F5', fontSize:16, fontFamily:FONT_BODY, outline:'none',
          }}
        />
        {loading && (
          <div style={{ position:'absolute', right:14, top:'50%', transform:'translateY(-50%)',
            fontSize:11, color:'#55556A', fontFamily:FONT_MONO }}>...</div>
        )}
      </div>

      {!results && !loading && (
        <div style={{ textAlign:'center', padding:'60px 0', color:'#55556A' }}>
          <div style={{ fontSize:40, marginBottom:12 }}>O</div>
          <div style={{ ...T.body }}>Search the entire league</div>
          <div style={{ ...T.sub }}>Characters, players, teams, news &mdash; all in one place</div>
        </div>
      )}

      {results && total === 0 && (
        <EmptyState title="No results" sub={`Nothing matched "${query}"`} />
      )}

      {results && results.profiles.length > 0 && (
        <div style={{ marginBottom:24 }}>
          <div style={{ ...T.cap, color:'#3B8EFF', marginBottom:10 }}>
            Players ({results.profiles.length})
          </div>
          <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
            {results.profiles.map(p => (
              <Card key={p.id} style={{ cursor:'pointer', padding:'10px 14px' }}
                onClick={() => goProfile(p.id)}>
                <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                  <div style={{ width:36, height:36, borderRadius:'50%', background:'#252530',
                    display:'flex', alignItems:'center', justifyContent:'center',
                    fontSize:14, fontWeight:800, color:'#3B8EFF', fontFamily:FONT_HEAD }}>
                    {(p.display_name||p.username||'?')[0].toUpperCase()}
                  </div>
                  <div>
                    <div style={{ ...T.body, fontWeight:600 }}>{p.display_name || p.username}</div>
                    {p.display_name && <div style={{ ...T.cap }}>{p.username}</div>}
                    {p.bio && <div style={{ ...T.sub, fontSize:11 }}>{p.bio.slice(0,80)}</div>}
                  </div>
                  <div style={{ marginLeft:'auto', ...T.cap, color:'#3B8EFF' }}>View profile &rsaquo;</div>
                </div>
              </Card>
            ))}
          </div>
        </div>
      )}

      {results && results.characters.length > 0 && (
        <div style={{ marginBottom:24 }}>
          <div style={{ ...T.cap, color:'#E8002D', marginBottom:10 }}>
            Characters ({results.characters.length})
          </div>
          <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
            {results.characters.map(c => (
              <Card key={c.id} style={{ padding:'10px 14px' }}>
                <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                  <div style={{ flex:1 }}>
                    <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                      <span style={{ ...T.body, fontWeight:600 }}>{c.name}</span>
                      <Badge color={c.type==='driver'?'#3B8EFF':'#FF9500'}>{c.type}</Badge>
                      {!c.is_active && <Badge color="#55556A">Inactive</Badge>}
                    </div>
                    {c.nationality && <div style={{ ...T.cap }}>{c.nationality}</div>}
                  </div>
                </div>
              </Card>
            ))}
          </div>
        </div>
      )}

      {results && results.teams.length > 0 && (
        <div style={{ marginBottom:24 }}>
          <div style={{ ...T.cap, color:'#FF9500', marginBottom:10 }}>
            Teams ({results.teams.length})
          </div>
          <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
            {results.teams.map(t => (
              <Card key={t.id} style={{ cursor:'pointer', padding:'10px 14px' }}
                onClick={goTeams}>
                <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                  <div style={{ width:6, height:36, borderRadius:3,
                    background:t.color||'#55556A', flexShrink:0 }} />
                  <div>
                    <div style={{ ...T.body, fontWeight:600 }}>{t.name}</div>
                    {t.tier && <div style={{ ...T.cap }}>{t.tier}</div>}
                  </div>
                  <div style={{ marginLeft:'auto', ...T.cap, color:'#FF9500' }}>Teams &rsaquo;</div>
                </div>
              </Card>
            ))}
          </div>
        </div>
      )}

      {results && results.news.length > 0 && (
        <div style={{ marginBottom:24 }}>
          <div style={{ ...T.cap, color:'#55556A', marginBottom:10 }}>
            News ({results.news.length})
          </div>
          <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
            {results.news.map(n => (
              <Card key={n.id} style={{ cursor:'pointer', padding:'10px 14px' }}
                onClick={() => setPage('notifications')}>
                <div style={{ ...T.body, fontWeight:600, marginBottom:4 }}>{n.title}</div>
                <div style={{ display:'flex', gap:8 }}>
                  {n.category && <Badge color="#55556A">{n.category.replace(/_/g,' ')}</Badge>}
                  <span style={{ ...T.cap }}>{new Date(n.created_at).toLocaleDateString()}</span>
                </div>
              </Card>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// -- Public Profile Page ------------------------------------------------------

function PublicProfilePage({ navTarget, setPage }) {
  const profileId = navTarget?.profileId;
  const [data,    setData]    = useState(null);
  const [chars,   setChars]   = useState([]);
  const [loading, setLoading] = useState(true);
  const [loaded,  setLoaded]  = useState(false);

  if (!loaded) {
    setLoaded(true);
    if (sbClient && profileId) {
      Promise.all([
        sbFetch(`profiles?id=eq.${profileId}&select=*&limit=1`),
        sbFetch(`characters?owner_id=eq.${profileId}&select=*&order=created_at&limit=20`),
      ]).then(([pr, cr]) => {
        setData((pr.data||[])[0] || null);
        setChars(cr.data||[]);
        setLoading(false);
      });
    } else setLoading(false);
  }

  if (loading) return <Spinner />;
  if (!profileId || !data) return (
    <div>
      <button onClick={() => setPage('search')}
        style={{ background:'none', border:'none', color:'#E8002D', cursor:'pointer',
          fontFamily:FONT_BODY, fontSize:14, marginBottom:20 }}>
        &larr; Back to Search
      </button>
      <EmptyState title="Profile not found" sub="This player profile could not be loaded" />
    </div>
  );

  const driverChars = chars.filter(c => c.type === 'driver');
  const staffChars  = chars.filter(c => c.type !== 'driver');

  return (
    <div>
      <button onClick={() => setPage('search')}
        style={{ background:'none', border:'none', color:'#55556A', cursor:'pointer',
          fontFamily:FONT_BODY, fontSize:14, marginBottom:20 }}>
        &larr; Back to Search
      </button>

      {/* Profile header */}
      <Card style={{ marginBottom:20 }}>
        <div style={{ display:'flex', alignItems:'center', gap:16, marginBottom:16 }}>
          <div style={{ width:64, height:64, borderRadius:'50%', background:'#252530',
            display:'flex', alignItems:'center', justifyContent:'center',
            fontSize:24, fontWeight:900, color:'#3B8EFF', fontFamily:FONT_HEAD }}>
            {(data.display_name||data.username||'?')[0].toUpperCase()}
          </div>
          <div>
            <div style={{ ...T.h1 }}>{data.display_name || data.username}</div>
            {data.display_name && (
              <div style={{ ...T.cap }}>@{data.username}</div>
            )}
            <div style={{ display:'flex', gap:6, marginTop:6 }}>
              <Badge color={data.role==='gm'?'#E8002D':data.role==='admin'?'#FFD700':'#3B8EFF'}>
                {data.role || 'player'}
              </Badge>
            </div>
          </div>
        </div>
        {data.bio && (
          <div style={{ ...T.body, lineHeight:1.8, marginBottom:12 }}>{data.bio}</div>
        )}
        {data.social_handle && (
          <div style={{ ...T.cap }}>Social: {data.social_handle}</div>
        )}
      </Card>

      {/* Characters */}
      {chars.length > 0 && (
        <div>
          <div style={{ ...T.cap, color:'#E8002D', marginBottom:10 }}>
            Characters ({chars.length})
          </div>
          <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
            {chars.map(c => (
              <Card key={c.id} style={{ padding:'12px 14px' }}>
                <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                  <div style={{ width:40, height:40, borderRadius:'50%', background:'#252530',
                    display:'flex', alignItems:'center', justifyContent:'center',
                    fontSize:16, fontWeight:900,
                    color: c.type==='driver'?'#E8002D':'#FF9500',
                    fontFamily:FONT_HEAD }}>
                    {c.number || (c.name||'?')[0].toUpperCase()}
                  </div>
                  <div style={{ flex:1 }}>
                    <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:3 }}>
                      <span style={{ ...T.body, fontWeight:600 }}>{c.name}</span>
                      <Badge color={c.type==='driver'?'#3B8EFF':'#FF9500'}>{c.type}</Badge>
                      <Badge color={c.is_active?'#00C46A':'#55556A'}>
                        {c.is_active?'Active':'Inactive'}
                      </Badge>
                    </div>
                    <div style={{ display:'flex', gap:12 }}>
                      {c.nationality && <span style={{ ...T.cap }}>{c.nationality}</span>}
                      {c.type === 'driver' && c.pace && (
                        <span style={{ ...T.cap }}>Pace: {c.pace}</span>
                      )}
                    </div>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        </div>
      )}

      {chars.length === 0 && (
        <EmptyState title="No characters" sub="This player has no characters yet" />
      )}
    </div>
  );
}

// -- Notifications Page -------------------------------------------------------

function NotificationsPage({ sbUser, onRead }) {
  const [notifs,  setNotifs]  = useState(null);
  const [news,    setNews]    = useState(null);
  const [loading, setLoading] = useState(true);
  const [loaded,  setLoaded]  = useState(false);
  const [tab,     setTab]     = useState('notifications');

  async function load() {
    const promises = [
      sbUser ? sbFetch(`notifications?recipient_id=eq.${sbUser.id}&order=created_at.desc&limit=50`) : Promise.resolve({ data:[] }),
      sbFetch('news_posts?order=created_at.desc&limit=50&select=*,profiles!author_id(username,display_name)'),
    ];
    const [nr, news_r] = await Promise.all(promises);
    setNotifs(nr.data || []);
    setNews(news_r.data || []);
    setLoading(false);
    onRead && onRead();
  }

  if (!loaded) { setLoaded(true); if (sbClient) load(); else { setLoading(false); setNotifs([]); setNews([]); } }
  if (loading) return <Spinner />;

  async function markRead(id) {
    await sbFetch(`notifications?id=eq.${id}`, {
      method:'PATCH', body: JSON.stringify({ read_at: new Date().toISOString() })
    });
    setNotifs(n => n.map(x => x.id === id ? { ...x, read_at: new Date().toISOString() } : x));
  }

  async function markAllRead() {
    const unread = (notifs||[]).filter(n => !n.read_at);
    await Promise.all(unread.map(n =>
      sbFetch(`notifications?id=eq.${n.id}`, {
        method:'PATCH', body: JSON.stringify({ read_at: new Date().toISOString() })
      })
    ));
    setNotifs(ns => ns.map(n => ({ ...n, read_at: n.read_at || new Date().toISOString() })));
  }

  const unreadCount = (notifs||[]).filter(n => !n.read_at).length;

  const NOTIF_ICON = {
    application_submitted: '[APP]',
    application_decided:   '[DEC]',
    result_published:      '[RES]',
    round_state_changed:   '[RND]',
    announcement:          '[ANN]',
  };
  const NOTIF_COLOR = {
    application_submitted: '#3B8EFF',
    application_decided:   '#00C46A',
    result_published:      '#FFD700',
    round_state_changed:   '#FF9500',
    announcement:          '#E8002D',
  };

  const categoryLabel = k => ({
    drivers_championship: 'Drivers',
    constructors_championship: 'Constructors',
    race_result: 'Race',
    qualifying_result: 'Qualifying',
    transfer: 'Transfer',
    announcement: 'Announcement',
    general: 'General',
  })[k] || 'News';
  const categoryColor = k => ({
    race_result: '#E8002D',
    qualifying_result: '#3B8EFF',
    transfer: '#FF9500',
    announcement: '#E8002D',
  })[k] || '#55556A';

  return (
    <div>
      <div style={{ ...T.cap, color:'#E8002D', marginBottom:4 }}>Inbox</div>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:20 }}>
        <div style={{ ...T.h1 }}>Notifications</div>
        {unreadCount > 0 && tab === 'notifications' && (
          <Button size="sm" variant="secondary" onClick={markAllRead}>
            Mark all read
          </Button>
        )}
      </div>

      {/* Tabs */}
      <div style={{ display:'flex', gap:4, marginBottom:20 }}>
        {[['notifications', `Notifications${unreadCount > 0 ? ` (${unreadCount})` : ''}`],
          ['news', 'League News']].map(([id,label]) => (
          <button key={id} onClick={() => setTab(id)}
            style={{ padding:'8px 18px', border:'none', borderRadius:6, fontSize:13, fontWeight:600,
              cursor:'pointer', background: tab === id ? '#E8002D' : '#111114',
              color: tab === id ? '#fff' : '#8888A0', fontFamily:FONT_BODY }}>
            {label}
          </button>
        ))}
      </div>

      {/* Personal notifications */}
      {tab === 'notifications' && (
        <div>
          {(!notifs || notifs.length === 0) && (
            <EmptyState title="All caught up" sub="No notifications yet" />
          )}
          <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
            {(notifs||[]).map(n => {
              const color = NOTIF_COLOR[n.kind] || '#55556A';
              return (
                <Card key={n.id}
                  style={{ opacity: n.read_at ? .6 : 1, borderLeft:`3px solid ${n.read_at?'#252530':color}` }}>
                  <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start' }}>
                    <div style={{ flex:1 }}>
                      <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:4 }}>
                        {!n.read_at && (
                          <div style={{ width:7, height:7, borderRadius:'50%', background:color, flexShrink:0 }} />
                        )}
                        <div style={{ ...T.cap, color }}>
                          {NOTIF_ICON[n.kind] || '[!]'} {n.kind?.replace(/_/g,' ')}
                        </div>
                      </div>
                      {n.payload?.message && (
                        <div style={{ ...T.body, marginBottom:4 }}>{n.payload.message}</div>
                      )}
                      {n.payload?.character_name && (
                        <div style={{ ...T.sub, fontSize:12 }}>Character: {n.payload.character_name}</div>
                      )}
                      <div style={{ ...T.cap, marginTop:6 }}>
                        {new Date(n.created_at).toLocaleString()}
                      </div>
                    </div>
                    {!n.read_at && (
                      <button onClick={() => markRead(n.id)}
                        style={{ background:'none', border:'none', color:'#55556A',
                          cursor:'pointer', fontSize:11, fontFamily:FONT_MONO, padding:'2px 6px' }}>
                        Dismiss
                      </button>
                    )}
                  </div>
                </Card>
              );
            })}
          </div>
        </div>
      )}

      {/* League news */}
      {tab === 'news' && (
        <div>
          {(!news || news.length === 0) && (
            <EmptyState title="No announcements yet"
              sub="League news and announcements will appear here" />
          )}
          <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
            {(news||[]).map(post => {
              const color = categoryColor(post.category);
              return (
                <Card key={post.id} style={{ borderLeft:`3px solid ${color}` }}>
                  {post.pinned && (
                    <div style={{ ...T.cap, color:'#FFD700', marginBottom:6 }}>PINNED</div>
                  )}
                  <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start',
                    marginBottom:8 }}>
                    <div>
                      <Badge color={color} style={{ marginBottom:8 }}>
                        {categoryLabel(post.category)}
                      </Badge>
                      <div style={{ ...T.h2 }}>{post.title}</div>
                    </div>
                  </div>
                  <div style={{ ...T.body, lineHeight:1.8, marginBottom:12 }}>
                    {post.body}
                  </div>
                  <div style={{ ...T.cap, color:'#55556A' }}>
                    Posted by {post.profiles?.display_name || post.profiles?.username || 'GM'}
                    {' '}&mdash; {new Date(post.created_at).toLocaleString()}
                  </div>
                </Card>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// -- Settings Page ------------------------------------------------------------

function SettingsPage({ profile, sbUser, onProfileUpdate }) {
  const [form, setForm] = useState({
    display_name: profile?.display_name||'',
    bio: profile?.bio||'',
    social_handle: profile?.social_handle||''
  });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const set = (k,v) => setForm(f => ({ ...f, [k]:v }));

  async function save() {
    setSaving(true);
    await sbFetch(`profiles?id=eq.${sbUser.id}`, {
      method:'PATCH', body: JSON.stringify({ ...form, updated_at: new Date().toISOString() })
    });
    setSaving(false); setSaved(true);
    setTimeout(() => setSaved(false), 2000);
    onProfileUpdate && onProfileUpdate({ ...profile, ...form });
  }

  return (
    <div style={{ maxWidth:500 }}>
      <div style={{ ...T.h1, marginBottom:8 }}>Settings</div>
      <div style={{ ...T.sub, marginBottom:24 }}>Manage your profile</div>
      <Card style={{ marginBottom:16 }}>
        <div style={{ ...T.cap, marginBottom:12 }}>Account</div>
        <div style={{ display:'flex', gap:10, marginBottom:8 }}>
          <span style={{ ...T.sub }}>Username:</span>
          <span style={{ ...T.body, fontWeight:600 }}>{profile?.username}</span>
        </div>
        <div style={{ display:'flex', gap:10 }}>
          <span style={{ ...T.sub }}>Role:</span>
          <Badge color={profile?.role === 'gm' ? '#E8002D' : '#3B8EFF'}>{profile?.role}</Badge>
        </div>
      </Card>
      <Card style={{ marginBottom:16 }}>
        <div style={{ ...T.cap, marginBottom:12 }}>Profile</div>
        <Input label="Display Name" value={form.display_name} onChange={v => set('display_name',v)} />
        <Textarea label="Bio" value={form.bio} onChange={v => set('bio',v)}
          placeholder="Tell the league about yourself..." rows={3} />
        <Input label="Social Handle" value={form.social_handle} onChange={v => set('social_handle',v)} placeholder="@handle" />
        <Button onClick={save} disabled={saving} variant={saved ? 'success' : 'primary'}>
          {saved ? 'Saved!' : saving ? 'Saving...' : 'Save Changes'}
        </Button>
      </Card>
      <Button variant="danger" onClick={sbSignOut}>Sign Out</Button>
    </div>
  );
}

// -- GM Overview --------------------------------------------------------------

function GMOverview({ setPage }) {
  const [stats,    setStats]    = useState(null);
  const [pending,  setPending]  = useState([]);
  const [loaded,   setLoaded]   = useState(false);

  if (!loaded) {
    setLoaded(true);
    if (sbClient) {
      Promise.all([
        sbFetch('profiles?select=id,role'),
        sbFetch('characters?select=id,is_active,type'),
        sbFetch('applications?select=id,status&order=created_at.desc'),
        sbFetch('rounds?select=id,state,circuit_id,scheduled_for&order=scheduled_for.asc&limit=3'),
      ]).then(([profiles, chars, apps, rounds]) => {
        const p = profiles.data || [];
        const c = chars.data    || [];
        const a = apps.data     || [];
        const r = rounds.data   || [];
        setStats({
          totalPlayers:  p.length,
          activePlayers: p.filter(x => x.role !== 'admin').length,
          totalChars:    c.length,
          activeDrivers: c.filter(x => x.is_active && x.type === 'driver').length,
          staffCount:    c.filter(x => x.is_active && x.type !== 'driver').length,
          pendingApps:   a.filter(x => ['submitted','under_review'].includes(x.status)).length,
          totalApps:     a.length,
          nextRound:     r[0] || null,
        });
        setPending(a.filter(x => ['submitted','under_review'].includes(x.status)).slice(0,5));
      });
    }
  }

  const S = stats;
  const statTiles = S ? [
    { label:'Total Players',  value:S.totalPlayers,  color:'#3B8EFF' },
    { label:'Active Drivers', value:S.activeDrivers, color:'#E8002D' },
    { label:'Staff Members',  value:S.staffCount,    color:'#FF9500' },
    { label:'Pending Apps',   value:S.pendingApps,   color: S.pendingApps > 0 ? '#FF9500' : '#00C46A' },
  ] : [];

  const rlbl = s => ({ scheduled:'Scheduled', orders_open:'Orders Open', locked:'Locked',
    in_progress:'Live', complete:'Complete' }[s] || s);
  const rclr = s => ({ scheduled:'#55556A', orders_open:'#3B8EFF', locked:'#FF9500',
    in_progress:'#E8002D', complete:'#00C46A' }[s] || '#55556A');

  return (
    <div>
      {/* Stat strip */}
      {!S ? <Spinner /> : (
        <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:12, marginBottom:28 }}>
          {statTiles.map(s => (
            <Card key={s.label} style={{ padding:'16px 20px' }}>
              <div style={{ ...T.cap, marginBottom:8 }}>{s.label}</div>
              <div style={{ fontSize:32, fontWeight:900, fontFamily:FONT_HEAD,
                color:s.color, lineHeight:1 }}>{s.value}</div>
            </Card>
          ))}
        </div>
      )}

      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:20, alignItems:'start' }}>

        {/* Application queue */}
        <Card>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:14 }}>
            <div style={{ ...T.h3 }}>Application Queue</div>
            {S && S.pendingApps > 0 && <Badge color='#FF9500'>{S.pendingApps} pending</Badge>}
          </div>
          {pending.length === 0 ? (
            <div style={{ ...T.sub }}>No pending applications</div>
          ) : (
            <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
              {pending.map(a => (
                <div key={a.id} style={{ display:'flex', justifyContent:'space-between',
                  alignItems:'center', padding:'8px 0', borderBottom:'1px solid #252530' }}>
                  <div style={{ ...T.sub, fontSize:12 }}>App #{a.id.slice(0,8)}</div>
                  <StatusBadge status={a.status} />
                </div>
              ))}
              <Button size='sm' variant='secondary' style={{ marginTop:6 }}
                onClick={() => setPage('applications')}>
                View All Applications
              </Button>
            </div>
          )}
        </Card>

        {/* Quick actions */}
        <Card>
          <div style={{ ...T.h3, marginBottom:14 }}>Quick Actions</div>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8 }}>
            {[
              ['Review Applications', 'applications'],
              ['Manage Players',      'players'],
              ['Edit Statistics',     'stats'],
              ['Race Control',        'race'],
              ['Audit Log',           'audit'],
              ['Teams',               'teams'],
            ].map(([lbl, pg]) => (
              <button key={pg} onClick={() => setPage(pg)}
                style={{ padding:'10px 14px', background:'#111114', border:'1px solid #252530',
                  borderRadius:7, color:'#8888A0', fontSize:12, fontFamily:FONT_BODY,
                  textAlign:'left', cursor:'pointer', transition:'all .15s' }}
                onMouseEnter={e => { e.currentTarget.style.borderColor='#E8002D';
                  e.currentTarget.style.color='#F0F0F5'; }}
                onMouseLeave={e => { e.currentTarget.style.borderColor='#252530';
                  e.currentTarget.style.color='#8888A0'; }}>
                {lbl}
              </button>
            ))}
          </div>
        </Card>
      </div>

      {/* Season summary */}
      {S?.nextRound && (
        <Card style={{ marginTop:20 }}>
          <div style={{ ...T.cap, color:'#E8002D', marginBottom:10 }}>Next Race</div>
          <div style={{ display:'flex', alignItems:'center', gap:16 }}>
            <div style={{ flex:1 }}>
              <div style={{ ...T.h3, marginBottom:4 }}>
                {S.nextRound.circuit_id || 'Circuit TBD'}
              </div>
              <div style={{ ...T.sub, fontSize:12 }}>
                {S.nextRound.scheduled_for
                  ? new Date(S.nextRound.scheduled_for).toLocaleDateString('en-GB',
                      { day:'numeric', month:'short', year:'numeric' })
                  : 'Date TBD'}
              </div>
            </div>
            <Badge color={rclr(S.nextRound.state)}>{rlbl(S.nextRound.state)}</Badge>
          </div>
        </Card>
      )}
    </div>
  );
}

// -- GM Control Centre --------------------------------------------------------

function GMControlPage({ sbUser, setPage: _setPage }) {
  const [tab, setTab] = useState('overview');
  const tabs = [
    { id:'overview',      label:'Overview' },
    { id:'applications',  label:'Applications' },
    { id:'players',       label:'Players' },
    { id:'characters',    label:'Characters' },
    { id:'teams',         label:'Teams' },
    { id:'stats',         label:'Edit Stats' },
    { id:'contracts',     label:'Contracts' },
    { id:'news',          label:'News' },
    { id:'race',          label:'Race Control' },
    { id:'league',        label:'League Settings' },
    { id:'audit',         label:'Audit Log' },
  ];

  // Allow GMOverview quick actions to switch tabs within GMControlPage
  function goTab(t) { setTab(t); }

  return (
    <div>
      <div style={{ marginBottom:24 }}>
        <div style={{ ...T.cap, color:'#E8002D', marginBottom:6 }}>GM Tools</div>
        <div style={{ ...T.h1, marginBottom:4 }}>GM Control Centre</div>
        <div style={{ ...T.sub }}>League management and race operations</div>
      </div>
      <div style={{ display:'flex', gap:4, marginBottom:24, flexWrap:'wrap' }}>
        {tabs.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            style={{ padding:'8px 16px', border:'none', borderRadius:6, fontSize:13, fontWeight:600,
              cursor:'pointer', background: tab === t.id ? '#E8002D' : '#111114',
              color: tab === t.id ? '#fff' : '#8888A0', transition:'all .15s',
              fontFamily:FONT_BODY }}>
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'overview'     && <GMOverview setPage={goTab} />}
      {tab === 'applications' && <GMApplications />}
      {tab === 'players'      && <GMPlayers />}
      {tab === 'characters'    && <GMCharacters />}
      {tab === 'teams'         && <GMTeams />}
      {tab === 'stats'        && <GMStats />}
      {tab === 'contracts'    && <GMContracts />}
      {tab === 'news'         && <GMNews sbUser={sbUser} />}
      {tab === 'race'         && <GMRaceControl sbUser={sbUser} />}
      {tab === 'league'       && <GMLeagueSettings />}
      {tab === 'audit'        && <GMAuditLog />}
    </div>
  );
}

function GMApplications() {
  const [apps,     setApps]     = useState(null);
  const [teams,    setTeams]    = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [loaded,   setLoaded]   = useState(false);
  const [expanded, setExpanded] = useState(null);
  const [approving,setApproving]= useState(null); // { appId, charId, teamId: '' }
  const [filter,   setFilter]   = useState('pending');

  async function load() {
    const [appsRes, teamsRes] = await Promise.all([
      sbFetch(
        'applications?order=created_at.desc' +
        '&select=*,characters(id,name,type),profiles!applicant_id(username),league_teams(name)'
      ),
      sbFetch('league_teams?order=name&select=id,name'),
    ]);
    setApps(appsRes.data || []);
    setTeams(teamsRes.data || []);
    setLoading(false);
  }

  if (!loaded) { setLoaded(true); if (sbClient) load(); else setLoading(false); }
  if (loading) return <Spinner />;

  async function decide(app, status, teamId, tier) {
    await sbFetch(`applications?id=eq.${app.id}`, {
      method:'PATCH',
      body: JSON.stringify({ status, decided_at: new Date().toISOString() })
    });
    if (status === 'approved' && app.characters?.id) {
      // Copy bio fields from form_data back to character record
      const fd = app.form_data || {};
      const charPatch = {};
      ['nationality','age','height','driving_style','strengths','weaknesses',
       'backstory_origin','backstory_journey','backstory_motivation',
       'media_persona','paddock_reputation','paddock_relations','iconic_quote'
      ].forEach(k => { if (fd[k]) charPatch[k] = fd[k]; });
      if (tier) {
        charPatch.stat_roll_tier    = tier;
        charPatch.stat_roll_pending = true;
      }
      if (Object.keys(charPatch).length > 0) {
        await sbFetch(`characters?id=eq.${app.characters.id}`, {
          method:'PATCH', body: JSON.stringify(charPatch)
        });
      }
      if (teamId) {
        await sbFetch('league_drivers', {
          method:'POST',
          headers:{ Prefer:'resolution=merge-duplicates' },
          body: JSON.stringify({ character_id: app.characters.id, team_id: teamId,
            name: app.characters.name, number: null })
        });
      }
    }
    // Send notification to applicant
    if (app.applicant_id) {
      const charName = app.characters?.name || 'your character';
      await sendNotification(app.applicant_id, 'application_decided', {
        message: status === 'approved'
          ? `Your application for ${charName} has been APPROVED. Welcome to the league!`
          : `Your application for ${charName} has been declined.`,
        character_name: charName,
        decision: status,
        stat_roll_tier: tier || null,
      });
    }
    setApproving(null);
    setExpanded(null);
    load();
  }

  const filters = ['pending','under_review','approved','rejected','all'];
  const filtered = !apps ? [] : filter === 'all' ? apps :
    filter === 'pending' ? apps.filter(a => ['submitted','under_review'].includes(a.status)) :
    apps.filter(a => a.status === filter);

  const FD_SECTIONS = [
    ['Character Details',       ['nationality','age','height']],
    ['Driver Profile',          ['driving_style','strengths','weaknesses']],
    ['Professional Profile',    ['specialisation','work_style','known_for']],
    ['Career History',          ['career_background','career_path','achievements']],
    ['Personal Backstory',      ['backstory_origin','backstory_journey','backstory_motivation']],
    ['Public Image / Relations',['media_persona','paddock_reputation','paddock_relations','personal_life']],
    ['Stat Requests',           ['pace','consistency','wet','overtaking','defense','experience','mental']],
    ['Quote & OOC',             ['iconic_quote','ooc_notes']],
  ];

  const STAT_KEYS = new Set(['pace','consistency','wet','overtaking','defense','experience','mental']);

  function renderFD(fd) {
    if (!fd || typeof fd !== 'object') return null;
    return FD_SECTIONS.map(([title, keys]) => {
      const filled = keys.filter(k => fd[k] !== undefined && fd[k] !== '' && fd[k] !== null);
      if (!filled.length) return null;
      return (
        <div key={title} style={{ marginBottom:14 }}>
          <div style={{ ...T.cap, color:'#E8002D', marginBottom:6 }}>{title}</div>
          {filled.map(k => {
            const v = fd[k];
            const label = k.replace(/_/g,' ');
            if (STAT_KEYS.has(k)) {
              return (
                <div key={k} style={{ display:'flex', alignItems:'center', gap:10, marginBottom:4 }}>
                  <div style={{ ...T.cap, width:120 }}>{label}</div>
                  <div style={{ flex:1, height:4, background:'#252530', borderRadius:2 }}>
                    <div style={{ height:'100%', background:'#E8002D', borderRadius:2,
                      width:`${k === 'mental' ? (v||0)*10 : (v||0)}%` }} />
                  </div>
                  <div style={{ fontSize:12, fontWeight:700, color:'#E8002D', width:30 }}>{v}</div>
                </div>
              );
            }
            return (
              <div key={k} style={{ marginBottom:6 }}>
                <div style={{ ...T.cap }}>{label}</div>
                <div style={{ ...T.sub, fontSize:12, padding:'4px 0' }}>{String(v)}</div>
              </div>
            );
          })}
        </div>
      );
    });
  }

  if (!apps || apps.length === 0) return <EmptyState title="No applications" sub="None submitted yet" />;

  return (
    <div>
      {/* Filter bar */}
      <div style={{ display:'flex', gap:6, marginBottom:20, flexWrap:'wrap' }}>
        {filters.map(f => (
          <button key={f} onClick={() => setFilter(f)}
            style={{ padding:'5px 12px', border:'none', borderRadius:5, fontSize:11, fontWeight:600,
              cursor:'pointer', textTransform:'uppercase', letterSpacing:'0.8px',
              background: filter === f ? '#E8002D' : '#111114',
              color: filter === f ? '#fff' : '#8888A0', fontFamily:FONT_MONO }}>
            {f === 'pending' ? `Pending (${apps.filter(a=>['submitted','under_review'].includes(a.status)).length})` : f}
          </button>
        ))}
      </div>

      {filtered.length === 0 && <EmptyState title={`No ${filter} applications`} />}

      <div style={{ display:'flex', flexDirection:'column', gap:12 }}>
        {filtered.map(app => {
          const isExp = expanded === app.id;
          const isApp = approving?.appId === app.id;
          return (
            <Card key={app.id}>
              {/* Header row */}
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start' }}>
                <div style={{ flex:1 }}>
                  <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:4 }}>
                    <div style={{ ...T.h3 }}>{app.characters?.name}</div>
                    <span style={{ ...T.cap, color:'#8888A0' }}>{app.characters?.type}</span>
                  </div>
                  <div style={{ ...T.sub, fontSize:12 }}>
                    by <strong style={{ color:'#F0F0F5' }}>{app.profiles?.username}</strong>
                    {app.league_teams?.name && <span> &middot; preferred: {app.league_teams.name}</span>}
                    <span> &middot; {new Date(app.created_at || Date.now()).toLocaleDateString()}</span>
                  </div>
                </div>
                <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                  <StatusBadge status={app.status} />
                  <button onClick={() => setExpanded(isExp ? null : app.id)}
                    style={{ background:'#111114', border:'none', borderRadius:5, padding:'4px 10px',
                      color:'#8888A0', cursor:'pointer', fontSize:11, fontFamily:FONT_MONO }}>
                    {isExp ? 'Collapse' : 'View Form'}
                  </button>
                </div>
              </div>

              {/* Expanded form data */}
              {isExp && (
                <div style={{ marginTop:16, paddingTop:16, borderTop:'1px solid #252530' }}>
                  {renderFD(app.form_data)}
                  {(!app.form_data || Object.keys(app.form_data).length === 0) && (
                    <div style={{ ...T.sub }}>No form data recorded (legacy submission).</div>
                  )}
                </div>
              )}

              {/* Action buttons for pending apps */}
              {['submitted','under_review'].includes(app.status) && !isApp && (
                <div style={{ display:'flex', gap:8, marginTop:12 }}>
                  <Button size="sm" variant="success" onClick={() =>
                    setApproving({ appId: app.id, charId: app.characters?.id, teamId: app.form_data?.team_id || '', tier: 'regular' })}>
                    Approve
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => decide(app,'under_review')}>
                    Mark Review
                  </Button>
                  <Button size="sm" variant="danger" onClick={() => decide(app,'rejected')}>
                    Reject
                  </Button>
                </div>
              )}

              {/* Inline approve panel */}
              {isApp && (
                <div style={{ marginTop:12, padding:'12px 14px', background:'#111114', borderRadius:8,
                  border:'1px solid #E8002D55' }}>
                  <div style={{ ...T.cap, color:'#00C46A', marginBottom:8 }}>Confirm Approval</div>
                  <div style={{ ...T.sub, fontSize:12, marginBottom:10 }}>
                    Optionally assign this character to a team and confirm:
                  </div>
                  <Select label="Assign to Team" value={approving.teamId}
                    onChange={v => setApproving(a => ({...a, teamId:v}))}
                    options={[{value:'',label:'No team assignment yet'},
                      ...teams.map(t => ({value:t.id,label:t.name}))]} />
                  <Select label="Stat Roll Tier"
                    value={approving.tier||'regular'}
                    onChange={v => setApproving(a => ({...a, tier:v}))}
                    options={[
                      {value:'rookie',  label:'Rookie  (55-70)'},
                      {value:'regular', label:'Regular (65-80)'},
                      {value:'veteran', label:'Veteran (72-85)'},
                      {value:'elite',   label:'Elite   (80-90)'},
                      {value:'legend',  label:'Legend  (87-96)'},
                    ]} />
                  <div style={{ display:'flex', gap:8, marginTop:10 }}>
                    <Button size="sm" variant="success"
                      onClick={() => decide(app,'approved', approving.teamId, approving.tier||'regular')}>
                      Confirm Approve
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => setApproving(null)}>
                      Cancel
                    </Button>
                  </div>
                </div>
              )}

              {/* Reopen decided apps */}
              {['approved','rejected'].includes(app.status) && (
                <div style={{ marginTop:12 }}>
                  <Button size="sm" variant="secondary" onClick={() => decide(app,'submitted')}>
                    Reopen
                  </Button>
                </div>
              )}
            </Card>
          );
        })}
      </div>
    </div>
  );
}

function GMPlayers() {
  const [players, setPlayers] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);

  if (!loaded) {
    setLoaded(true);
    if (sbClient) {
      sbFetch('profiles?order=created_at&select=*').then(({ data }) => { setPlayers(data || []); setLoading(false); });
    } else setLoading(false);
  }

  if (loading) return <Spinner />;
  if (!players || players.length === 0) return <EmptyState title="No players" />;

  async function setRole(id, role) {
    await sbFetch(`profiles?id=eq.${id}`, { method:'PATCH', body: JSON.stringify({ role }) });
    setPlayers(p => p.map(x => x.id === id ? { ...x, role } : x));
  }

  return (
    <div>
      <div style={{ ...T.h2, marginBottom:14 }}>All Players ({players.length})</div>
      <Card style={{ padding:0, overflow:'hidden' }}>
        {players.map((p, i) => (
          <div key={p.id} style={{ display:'flex', alignItems:'center', gap:12, padding:'12px 16px',
            borderBottom: i < players.length-1 ? '1px solid #252530' : 'none' }}>
            <div style={{ width:34, height:34, borderRadius:'50%', background:'#252530',
              display:'flex', alignItems:'center', justifyContent:'center', fontWeight:700, color:'#E8002D' }}>
              {p.username[0].toUpperCase()}
            </div>
            <div style={{ flex:1 }}>
              <div style={{ ...T.body, fontWeight:600 }}>{p.username}</div>
              <div style={{ ...T.cap }}>{new Date(p.created_at).toLocaleDateString()}</div>
            </div>
            <select value={p.role} onChange={e => setRole(p.id, e.target.value)}
              style={{ background:'#111114', border:'1px solid #252530', borderRadius:6,
                padding:'4px 8px', color:'#F0F0F5', fontSize:12 }}>
              <option value="player">Player</option>
              <option value="gm">GM</option>
              <option value="admin">Admin</option>
            </select>
          </div>
        ))}
      </Card>
    </div>
  );
}

function GMStats() {
  const [chars,    setChars]    = useState(null);
  const [selected, setSelected] = useState(null);
  const [loading,  setLoading]  = useState(true);
  const [loaded,   setLoaded]   = useState(false);
  const [saving,   setSaving]   = useState(false);
  const [editForm, setEditForm] = useState({});
  const [history,  setHistory]  = useState([]);  // change log this session
  const [charType, setCharType] = useState('driver');

  function reload() {
    if (!sbClient) { setLoading(false); return; }
    const q = charType === 'all' ? 'characters?order=name&select=*' :
              `characters?type=eq.${charType}&order=name&select=*`;
    sbFetch(q).then(({ data }) => { setChars(data || []); setLoading(false); });
  }

  if (!loaded) { setLoaded(true); reload(); }

  function selectChar(c) {
    setSelected(c);
    setEditForm({ pace:c.pace||70, consistency:c.consistency||70, wet:c.wet||70,
      overtaking:c.overtaking||70, defense:c.defense||70,
      experience:c.experience||50, mental:c.mental||7 });
  }

  async function saveStats() {
    setSaving(true);
    // Record changes
    const changes = Object.entries(editForm).filter(([k,v]) => selected[k] !== v);
    if (changes.length > 0) {
      setHistory(h => [{
        charName: selected.name,
        at: new Date().toLocaleTimeString(),
        changes: changes.map(([k,v]) => ({ field:k, from:selected[k], to:v }))
      }, ...h.slice(0,19)]);
    }
    await sbFetch(`characters?id=eq.${selected.id}`, {
      method:'PATCH', body: JSON.stringify({ ...editForm, updated_at: new Date().toISOString() })
    });
    setSaving(false);
    setChars(c => c.map(x => x.id === selected.id ? { ...x, ...editForm } : x));
    setSelected(null);
  }

  function reloadType(t) {
    setCharType(t); setChars(null); setLoading(true); setLoaded(false);
  }

  if (loading) return <Spinner />;

  if (selected) {
    const isDriver = selected.type === 'driver';
    const changed = Object.entries(editForm).filter(([k,v]) => selected[k] !== v);
    return (
      <div style={{ maxWidth:540 }}>
        <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:20 }}>
          <button onClick={() => setSelected(null)}
            style={{ background:'none', border:'none', color:'#8888A0', cursor:'pointer',
              fontSize:14, fontFamily:FONT_BODY, padding:0 }}>
            &lt; Back
          </button>
          <div style={{ flex:1 }}>
            <div style={{ ...T.cap, color:'#E8002D', marginBottom:2 }}>{selected.type}</div>
            <div style={{ ...T.h2 }}>{selected.name}</div>
          </div>
          {changed.length > 0 && (
            <div style={{ ...T.cap, color:'#FF9500' }}>{changed.length} change{changed.length>1?'s':''} pending</div>
          )}
        </div>

        {/* Change preview */}
        {changed.length > 0 && (
          <div style={{ background:'#FF950010', border:'1px solid #FF950033', borderRadius:8,
            padding:'10px 14px', marginBottom:16 }}>
            <div style={{ ...T.cap, color:'#FF9500', marginBottom:6 }}>Pending changes</div>
            {changed.map(([k,v]) => (
              <div key={k} style={{ display:'flex', gap:8, fontSize:12, marginBottom:3 }}>
                <span style={{ color:'#8888A0', width:110 }}>{k}</span>
                <span style={{ color:'#E8002D' }}>{selected[k]}</span>
                <span style={{ color:'#55556A' }}>-&gt;</span>
                <span style={{ color:'#00C46A' }}>{v}</span>
              </div>
            ))}
          </div>
        )}

        <Card>
          {isDriver && [
            ['pace',       'Pace',        '#E8002D'],
            ['consistency','Consistency', '#3B8EFF'],
            ['wet',        'Wet Skill',   '#3B8EFF'],
            ['overtaking', 'Overtaking',  '#FF9500'],
            ['defense',    'Defense',     '#FF9500'],
            ['experience', 'Experience',  '#55556A'],
          ].map(([k,l,c]) => (
            <div key={k} style={{ marginBottom:14 }}>
              <div style={{ display:'flex', justifyContent:'space-between', marginBottom:4 }}>
                <span style={{ ...T.cap, color: editForm[k] !== selected[k] ? '#FF9500' : undefined }}>{l}</span>
                <span style={{ fontSize:13, fontWeight:700, color:c }}>{editForm[k]}</span>
              </div>
              <input type="range" min={40} max={99} value={editForm[k]}
                onChange={e => setEditForm(f => ({ ...f, [k]: parseInt(e.target.value) }))}
                style={{ width:'100%', accentColor:c }} />
            </div>
          ))}
          {isDriver && (
            <div style={{ marginBottom:14 }}>
              <div style={{ display:'flex', justifyContent:'space-between', marginBottom:4 }}>
                <span style={{ ...T.cap, color: editForm.mental !== selected.mental ? '#FF9500' : undefined }}>
                  Mental
                </span>
                <span style={{ fontSize:13, fontWeight:700, color:'#00C46A' }}>{editForm.mental}/10</span>
              </div>
              <input type="range" min={1} max={10} value={editForm.mental}
                onChange={e => setEditForm(f => ({ ...f, mental: parseInt(e.target.value) }))}
                style={{ width:'100%', accentColor:'#00C46A' }} />
            </div>
          )}
          {!isDriver && (
            <div style={{ ...T.sub }}>
              Staff stat editing coming in a future update.
            </div>
          )}
          <div style={{ display:'flex', gap:10, marginTop:4 }}>
            <Button onClick={saveStats} disabled={saving || changed.length === 0}>
              {saving ? 'Saving...' : `Save${changed.length ? ` (${changed.length})` : ''}`}
            </Button>
            <Button variant="secondary" onClick={() => setSelected(null)}>Cancel</Button>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div style={{ display:'grid', gridTemplateColumns:'1fr 300px', gap:20, alignItems:'start' }}>
      <div>
        {/* Type filter */}
        <div style={{ display:'flex', gap:6, marginBottom:16 }}>
          {['driver','staff','all'].map(t => (
            <button key={t} onClick={() => reloadType(t)}
              style={{ padding:'5px 12px', border:'none', borderRadius:5, fontSize:11, fontWeight:600,
                cursor:'pointer', textTransform:'uppercase', letterSpacing:'0.8px',
                background: charType === t ? '#E8002D' : '#111114',
                color: charType === t ? '#fff' : '#8888A0', fontFamily:FONT_MONO }}>
              {t}
            </button>
          ))}
        </div>
        {(!chars || chars.length === 0) && <EmptyState title="No characters" />}
        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(260px,1fr))', gap:12 }}>
          {(chars||[]).map(c => (
            <Card key={c.id} onClick={() => selectChar(c)}>
              <div style={{ display:'flex', justifyContent:'space-between', marginBottom:8 }}>
                <div>
                  <div style={{ ...T.h3 }}>{c.name}</div>
                  <div style={{ ...T.cap }}>{c.type}</div>
                </div>
                <Button size="sm" variant="secondary">Edit</Button>
              </div>
              {c.type === 'driver' && (
                <>
                  <StatBar label="Pace"        value={c.pace||0}        color="#E8002D" />
                  <StatBar label="Consistency" value={c.consistency||0} color="#3B8EFF" />
                </>
              )}
            </Card>
          ))}
        </div>
      </div>

      {/* Change history sidebar */}
      <div>
        <div style={{ ...T.h3, marginBottom:12 }}>Change History</div>
        {history.length === 0 ? (
          <div style={{ ...T.sub }}>No changes this session yet.</div>
        ) : (
          <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
            {history.map((entry, i) => (
              <Card key={i} style={{ padding:'10px 12px' }}>
                <div style={{ ...T.cap, color:'#E8002D', marginBottom:4 }}>{entry.charName}</div>
                <div style={{ ...T.cap, marginBottom:6 }}>{entry.at}</div>
                {entry.changes.map(ch => (
                  <div key={ch.field} style={{ display:'flex', gap:6, fontSize:11, marginBottom:2 }}>
                    <span style={{ color:'#8888A0', width:90, flexShrink:0 }}>{ch.field}</span>
                    <span style={{ color:'#E8002D' }}>{ch.from}</span>
                    <span style={{ color:'#55556A' }}>&gt;</span>
                    <span style={{ color:'#00C46A' }}>{ch.to}</span>
                  </div>
                ))}
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function GMCharacters() {
  const [chars,       setChars]       = useState(null);
  const [loading,     setLoading]     = useState(true);
  const [loaded,      setLoaded]      = useState(false);
  const [editing,     setEditing]     = useState(null);
  const [editForm,    setEditForm]    = useState({});
  const [saving,      setSaving]      = useState(false);
  const [charType,    setCharType]    = useState('all');
  const [transferring,setTransferring]= useState(null);
  const [teams,       setTeams]       = useState([]);
  const [xferTeam,    setXferTeam]    = useState('');
  const [xferSaving,  setXferSaving]  = useState(false);
  const [xferErr,     setXferErr]     = useState('');

  async function load() {
    const base = 'characters?order=name&select=*,profiles!owner_id(username),league_teams!team_id(id,name,color)';
    const q = charType === 'all' ? base : base + `&type=eq.${charType}`;
    const { data } = await sbFetch(q);
    setChars(data||[]); setLoading(false);
  }

  async function openTransfer(c) {
    setXferErr(''); setXferTeam(c.team_id||'');
    if (!teams.length) {
      const { data } = await sbFetch('league_teams?order=name&select=id,name,color');
      setTeams(data||[]);
    }
    setTransferring(c);
  }

  async function doTransfer() {
    if (xferSaving) return;
    setXferSaving(true); setXferErr('');
    const newTeam = xferTeam || null;

    const r1 = await sbFetch(`characters?id=eq.${transferring.id}`, {
      method:'PATCH', body:JSON.stringify({ team_id: newTeam }),
    });
    if (r1.error) { setXferErr(String(r1.error)); setXferSaving(false); return; }

    // Upsert league_drivers entry
    const { data: existing } = await sbFetch(`league_drivers?character_id=eq.${transferring.id}&select=id`);
    if (existing && existing.length > 0) {
      await sbFetch(`league_drivers?character_id=eq.${transferring.id}`, {
        method:'PATCH', body:JSON.stringify({ team_id: newTeam }),
      });
    } else if (newTeam) {
      await sbFetch('league_drivers', {
        method:'POST', body:JSON.stringify({ character_id: transferring.id, team_id: newTeam }),
      });
    }

    setXferSaving(false); setTransferring(null); setXferTeam('');
    setLoaded(false); setLoading(true); load();
  }

  if (!loaded) { setLoaded(true); if (sbClient) load(); else setLoading(false); }
  if (loading) return <Spinner />;

  function startEdit(c) {
    setEditing(c);
    setEditForm({ name:c.name||'', nationality:c.nationality||'', bio:c.bio||'',
      backstory:c.backstory||'', is_active:c.is_active, number:c.number||'',
      abbr:c.abbr||'', style:c.style||'' });
  }

  async function saveChar() {
    setSaving(true);
    await sbFetch(`characters?id=eq.${editing.id}`, {
      method:'PATCH', body: JSON.stringify({ ...editForm, updated_at:new Date().toISOString() })
    });
    setSaving(false);
    setEditing(null);
    setLoaded(false); setLoading(true); load();
  }

  async function toggleActive(c) {
    await sbFetch(`characters?id=eq.${c.id}`, {
      method:'PATCH', body: JSON.stringify({ is_active: !c.is_active })
    });
    setChars(ch => ch.map(x => x.id === c.id ? {...x, is_active:!x.is_active} : x));
  }

  function reloadType(t) {
    setCharType(t); setChars(null); setLoading(true); setLoaded(false);
  }

  if (transferring) {
    const curTeam = teams.find(t => t.id === transferring.team_id);
    return (
      <div style={{ maxWidth:500 }}>
        <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:20 }}>
          <button onClick={() => setTransferring(null)}
            style={{ background:'none', border:'none', color:'#8888A0', cursor:'pointer',
              fontSize:14, fontFamily:FONT_BODY, padding:0 }}>&lt; Back</button>
          <div style={{ ...T.h2 }}>Transfer: {transferring.name}</div>
        </div>
        <Card>
          <div style={{ ...T.cap, color:'#8888A0', marginBottom:14 }}>
            Current team: <span style={{ color:'#F0F0F5' }}>{curTeam ? curTeam.name : 'None'}</span>
          </div>
          <div style={{ marginBottom:14 }}>
            <label style={{ ...T.cap, color:'#8888A0', display:'block', marginBottom:6 }}>Transfer to Team</label>
            <select value={xferTeam} onChange={e => setXferTeam(e.target.value)}
              style={{ width:'100%', background:'#111114', border:'1px solid #252530', borderRadius:6,
                color:'#F0F0F5', padding:'8px 10px', fontFamily:FONT_BODY, fontSize:13 }}>
              <option value="">— Remove from team —</option>
              {teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </div>
          {xferErr && <div style={{ color:'#E8002D', fontSize:13, marginBottom:10 }}>{xferErr}</div>}
          <div style={{ display:'flex', gap:10 }}>
            <Button onClick={doTransfer} disabled={xferSaving}>
              {xferSaving ? 'Transferring...' : 'Confirm Transfer'}
            </Button>
            <Button variant="secondary" onClick={() => setTransferring(null)}>Cancel</Button>
          </div>
        </Card>
      </div>
    );
  }

  if (editing) {
    const set = (k,v) => setEditForm(f => ({...f,[k]:v}));
    return (
      <div style={{ maxWidth:580 }}>
        <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:20 }}>
          <button onClick={() => setEditing(null)}
            style={{ background:'none', border:'none', color:'#8888A0',
              cursor:'pointer', fontSize:14, fontFamily:FONT_BODY, padding:0 }}>
            &lt; Back
          </button>
          <div style={{ ...T.h2 }}>Edit: {editing.name}</div>
        </div>
        <Card>
          <Input label="Name" value={editForm.name} onChange={v => set('name',v)} />
          <Input label="Nationality" value={editForm.nationality} onChange={v => set('nationality',v)} />
          {editing.type === 'driver' && (
            <>
              <Input label="Number" value={editForm.number} onChange={v => set('number',v)} placeholder="e.g. 44" />
              <Input label="Abbreviation" value={editForm.abbr} onChange={v => set('abbr',v)} placeholder="e.g. HAM" />
              <Input label="Driving Style" value={editForm.style} onChange={v => set('style',v)} />
            </>
          )}
          <Textarea label="Bio / Quote" value={editForm.bio} onChange={v => set('bio',v)} rows={3} />
          <Textarea label="Backstory" value={editForm.backstory} onChange={v => set('backstory',v)} rows={5} />
          <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:14 }}>
            <label style={{ ...T.cap }}>Active</label>
            <input type="checkbox" checked={!!editForm.is_active}
              onChange={e => set('is_active', e.target.checked)}
              style={{ width:16, height:16, accentColor:'#E8002D' }} />
          </div>
          <div style={{ display:'flex', gap:10 }}>
            <Button onClick={saveChar} disabled={saving}>{saving ? 'Saving...' : 'Save Changes'}</Button>
            <Button variant="secondary" onClick={() => setEditing(null)}>Cancel</Button>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div>
      <div style={{ display:'flex', gap:6, marginBottom:16 }}>
        {['all','driver','staff'].map(t => (
          <button key={t} onClick={() => reloadType(t)}
            style={{ padding:'5px 12px', border:'none', borderRadius:5, fontSize:11, fontWeight:600,
              cursor:'pointer', textTransform:'uppercase', letterSpacing:'0.8px',
              background: charType === t ? '#E8002D' : '#111114',
              color: charType === t ? '#fff' : '#8888A0', fontFamily:FONT_MONO }}>
            {t}
          </button>
        ))}
      </div>
      {(!chars || chars.length === 0) && <EmptyState title="No characters" />}
      <Card style={{ padding:0, overflow:'hidden' }}>
        {(chars||[]).map((c, i) => (
          <div key={c.id} style={{ display:'flex', alignItems:'center', gap:12, padding:'11px 16px',
            borderBottom: i < (chars||[]).length-1 ? '1px solid #252530' : 'none' }}>
            <div style={{ width:34, height:34, borderRadius:'50%', background:'#252530',
              display:'flex', alignItems:'center', justifyContent:'center',
              fontSize:13, fontWeight:800, color:'#E8002D', fontFamily:FONT_HEAD }}>
              {c.number || (c.name||'?')[0].toUpperCase()}
            </div>
            <div style={{ flex:1 }}>
              <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                <span style={{ ...T.body, fontWeight:600 }}>{c.name}</span>
                <Badge color={c.is_active ? '#00C46A' : '#55556A'}>
                  {c.is_active ? 'Active' : 'Inactive'}
                </Badge>
                {c.league_teams?.name && (
                  <Badge color={c.league_teams.color||'#55556A'}>{c.league_teams.name}</Badge>
                )}
              </div>
              <div style={{ ...T.cap }}>{c.type}{c.profiles?.username ? ` · ${c.profiles.username}` : ''}{!c.team_id ? ' · No team' : ''}</div>
            </div>
            <div style={{ display:'flex', gap:8 }}>
              <Button size="sm" variant="secondary" onClick={() => openTransfer(c)}>Transfer</Button>
              <Button size="sm" variant="secondary" onClick={() => startEdit(c)}>Edit</Button>
              <Button size="sm" variant={c.is_active ? 'danger' : 'success'}
                onClick={() => toggleActive(c)}>
                {c.is_active ? 'Retire' : 'Activate'}
              </Button>
            </div>
          </div>
        ))}
      </Card>
    </div>
  );
}

function GMTeams() {
  const [teams,   setTeams]   = useState(null);
  const [loading, setLoading] = useState(true);
  const [loaded,  setLoaded]  = useState(false);
  const [editing, setEditing] = useState(null);
  const [editForm,setEditForm]= useState({});
  const [saving,  setSaving]  = useState(false);
  const [creating,setCreating]= useState(false);
  const [newForm, setNewForm] = useState({ name:'', color:'#E8002D' });
  const [savingNew,setSavingNew]=useState(false);

  async function load() {
    const { data } = await sbFetch('league_teams?order=name&select=*');
    setTeams(data||[]); setLoading(false);
  }

  if (!loaded) { setLoaded(true); if (sbClient) load(); else setLoading(false); }
  if (loading) return <Spinner />;

  function startEdit(t) {
    setEditing(t);
    setEditForm({ name:t.name||'', color:t.color||'#E8002D', tier:t.tier||'',
      car_pace:t.car_pace||70, reliability:t.reliability||75,
      pit_speed:t.pit_speed||70, tyre_life:t.tyre_life||70 });
  }

  async function saveTeam() {
    setSaving(true);
    await sbFetch(`league_teams?id=eq.${editing.id}`, {
      method:'PATCH', body: JSON.stringify(editForm)
    });
    setSaving(false);
    setEditing(null);
    setLoaded(false); setLoading(true); load();
  }

  async function createTeam() {
    if (!newForm.name.trim()) return;
    setSavingNew(true);
    await sbFetch('league_teams', {
      method:'POST', body: JSON.stringify({ ...newForm, car_pace:70, reliability:75, pit_speed:70, tyre_life:70 })
    });
    setSavingNew(false);
    setCreating(false);
    setNewForm({ name:'', color:'#E8002D' });
    setLoaded(false); setLoading(true); load();
  }

  if (editing) {
    const set = (k,v) => setEditForm(f => ({...f,[k]:v}));
    return (
      <div style={{ maxWidth:500 }}>
        <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:20 }}>
          <button onClick={() => setEditing(null)}
            style={{ background:'none', border:'none', color:'#8888A0',
              cursor:'pointer', fontSize:14, fontFamily:FONT_BODY, padding:0 }}>
            &lt; Back
          </button>
          <div style={{ ...T.h2 }}>Edit: {editing.name}</div>
        </div>
        <Card>
          <Input label="Team Name" value={editForm.name} onChange={v => set('name',v)} />
          <div style={{ marginBottom:14 }}>
            <div style={{ ...T.cap, marginBottom:6 }}>Team Colour</div>
            <input type="color" value={editForm.color} onChange={e => set('color',e.target.value)}
              style={{ width:'100%', height:36, borderRadius:6, border:'1px solid #252530',
                background:'transparent', cursor:'pointer' }} />
          </div>
          <Input label="Tier / Division" value={editForm.tier} onChange={v => set('tier',v)}
            placeholder="e.g. Top, Midfield, Backmarker" />
          {[['car_pace','Car Pace','#E8002D'],['reliability','Reliability','#00C46A'],
            ['pit_speed','Pit Speed','#3B8EFF'],['tyre_life','Tyre Life','#FF9500']].map(([k,l,c]) => (
            <div key={k} style={{ marginBottom:14 }}>
              <div style={{ display:'flex', justifyContent:'space-between', marginBottom:4 }}>
                <span style={{ ...T.cap }}>{l}</span>
                <span style={{ fontSize:13, fontWeight:700, color:c }}>{editForm[k]}</span>
              </div>
              <input type="range" min={40} max={99} value={editForm[k]}
                onChange={e => set(k, parseInt(e.target.value))}
                style={{ width:'100%', accentColor:c }} />
            </div>
          ))}
          <div style={{ display:'flex', gap:10 }}>
            <Button onClick={saveTeam} disabled={saving}>{saving ? 'Saving...' : 'Save Team'}</Button>
            <Button variant="secondary" onClick={() => setEditing(null)}>Cancel</Button>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:16 }}>
        <div style={{ ...T.h2 }}>All Teams ({(teams||[]).length})</div>
        <Button onClick={() => setCreating(!creating)}>+ New Team</Button>
      </div>

      {creating && (
        <Card style={{ marginBottom:20 }}>
          <div style={{ ...T.cap, color:'#E8002D', marginBottom:10 }}>Create Team</div>
          <Input label="Team Name" value={newForm.name}
            onChange={v => setNewForm(f => ({...f,name:v}))} />
          <div style={{ marginBottom:14 }}>
            <div style={{ ...T.cap, marginBottom:6 }}>Colour</div>
            <input type="color" value={newForm.color}
              onChange={e => setNewForm(f => ({...f,color:e.target.value}))}
              style={{ width:'100%', height:36, borderRadius:6, border:'1px solid #252530',
                background:'transparent', cursor:'pointer' }} />
          </div>
          <div style={{ display:'flex', gap:10 }}>
            <Button onClick={createTeam} disabled={savingNew}>
              {savingNew ? 'Creating...' : 'Create Team'}
            </Button>
            <Button variant="secondary" onClick={() => setCreating(false)}>Cancel</Button>
          </div>
        </Card>
      )}

      {(!teams || teams.length === 0) && !creating && <EmptyState title="No teams yet" sub="Create the first team above" />}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(280px,1fr))', gap:14 }}>
        {(teams||[]).map(t => (
          <Card key={t.id}>
            <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:12 }}>
              <div style={{ width:6, height:40, borderRadius:3, background:t.color||'#E8002D', flexShrink:0 }} />
              <div style={{ flex:1 }}>
                <div style={{ ...T.h3 }}>{t.name}</div>
                {t.tier && <div style={{ ...T.cap }}>{t.tier}</div>}
              </div>
              <Button size="sm" variant="secondary" onClick={() => startEdit(t)}>Edit</Button>
            </div>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8 }}>
              {[['Car Pace',t.car_pace,'#E8002D'],['Reliability',t.reliability,'#00C46A'],
                ['Pit Speed',t.pit_speed,'#3B8EFF'],['Tyre Life',t.tyre_life,'#FF9500']].map(([l,v,c]) => (
                <div key={l}>
                  <div style={{ ...T.cap }}>{l}</div>
                  <div style={{ fontSize:20, fontWeight:900, color:c, fontFamily:FONT_HEAD }}>{v||'--'}</div>
                </div>
              ))}
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}

function GMNews({ sbUser }) {
  const [posts,   setPosts]   = useState(null);
  const [loading, setLoading] = useState(true);
  const [loaded,  setLoaded]  = useState(false);
  const [creating,setCreating]= useState(false);
  const [saving,  setSaving]  = useState(false);
  const [form,    setForm]    = useState({ title:'', body:'', category:'announcement', pinned:false });
  const set = (k,v) => setForm(f => ({...f,[k]:v}));

  async function load() {
    const { data } = await sbFetch('news_posts?order=created_at.desc&limit=100&select=*,profiles!author_id(username)');
    setPosts(data||[]); setLoading(false);
  }

  if (!loaded) { setLoaded(true); if (sbClient) load(); else setLoading(false); }
  if (loading) return <Spinner />;

  async function createPost() {
    if (!form.title.trim()) return;
    setSaving(true);
    await sbFetch('news_posts', {
      method:'POST',
      body: JSON.stringify({ ...form, author_id: sbUser?.id })
    });
    setSaving(false);
    setCreating(false);
    setForm({ title:'', body:'', category:'announcement', pinned:false });
    setLoaded(false); setLoading(true); load();
  }

  async function deletePost(id) {
    await sbFetch(`news_posts?id=eq.${id}`, { method:'DELETE' });
    setPosts(p => p.filter(x => x.id !== id));
  }

  async function togglePin(post) {
    await sbFetch(`news_posts?id=eq.${post.id}`, {
      method:'PATCH', body: JSON.stringify({ pinned: !post.pinned })
    });
    setPosts(p => p.map(x => x.id === post.id ? {...x, pinned:!x.pinned} : x));
  }

  const CATEGORIES = ['announcement','race_result','qualifying_result','transfer','drivers_championship',
    'constructors_championship','general'];
  const catColor = k => ({ race_result:'#E8002D', qualifying_result:'#3B8EFF', transfer:'#FF9500',
    announcement:'#E8002D', drivers_championship:'#FFD700' })[k] || '#55556A';

  return (
    <div>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:16 }}>
        <div style={{ ...T.h3 }}>League News</div>
        <Button onClick={() => setCreating(!creating)}>+ New Post</Button>
      </div>

      {creating && (
        <Card style={{ marginBottom:20 }}>
          <div style={{ ...T.cap, color:'#E8002D', marginBottom:10 }}>Create Post</div>
          <Input label="Headline" value={form.title} onChange={v => set('title',v)}
            placeholder="e.g. Round 3 Results: Verstappen Dominates Monaco" />
          <Textarea label="Body" value={form.body} onChange={v => set('body',v)}
            placeholder="Full announcement text..." rows={6} />
          <Select label="Category" value={form.category} onChange={v => set('category',v)}
            options={CATEGORIES.map(c => ({ value:c, label:c.replace(/_/g,' ') }))} />
          <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:14 }}>
            <label style={{ ...T.cap }}>Pin to top</label>
            <input type="checkbox" checked={form.pinned}
              onChange={e => set('pinned', e.target.checked)}
              style={{ width:16, height:16, accentColor:'#FFD700' }} />
          </div>
          <div style={{ display:'flex', gap:10 }}>
            <Button onClick={createPost} disabled={saving}>{saving?'Posting...':'Post'}</Button>
            <Button variant="secondary" onClick={() => setCreating(false)}>Cancel</Button>
          </div>
        </Card>
      )}

      {(!posts || posts.length === 0) && !creating && (
        <EmptyState title="No posts yet" sub="Post the first league announcement above" />
      )}

      <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
        {(posts||[]).map(post => (
          <Card key={post.id} style={{ borderLeft:`3px solid ${catColor(post.category)}` }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start' }}>
              <div style={{ flex:1, marginRight:12 }}>
                {post.pinned && (
                  <div style={{ ...T.cap, color:'#FFD700', marginBottom:4 }}>PINNED</div>
                )}
                <Badge color={catColor(post.category)} style={{ marginBottom:6 }}>
                  {post.category?.replace(/_/g,' ')}
                </Badge>
                <div style={{ ...T.h3, marginBottom:6 }}>{post.title}</div>
                {post.body && (
                  <div style={{ ...T.sub, fontSize:13, lineHeight:1.7, marginBottom:8 }}>
                    {post.body.length > 200 ? post.body.slice(0,200) + '...' : post.body}
                  </div>
                )}
                <div style={{ ...T.cap, color:'#55556A' }}>
                  {post.profiles?.username || 'GM'} &middot; {new Date(post.created_at).toLocaleString()}
                </div>
              </div>
              <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
                <Button size="sm" variant="secondary" onClick={() => togglePin(post)}>
                  {post.pinned ? 'Unpin' : 'Pin'}
                </Button>
                <Button size="sm" variant="danger" onClick={() => deletePost(post.id)}>Delete</Button>
              </div>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}

function GMContracts() {
  const [drivers,  setDrivers]  = useState(null);
  const [teams,    setTeams]    = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [loaded,   setLoaded]   = useState(false);
  const [transferring, setTransferring] = useState(null); // { driverId, teamId: '' }
  const [saving,   setSaving]   = useState(false);

  async function load() {
    const [dr, tr] = await Promise.all([
      sbFetch('league_drivers?select=*,characters(name,type,is_active,nationality),league_teams(id,name,color)&order=created_at.asc'),
      sbFetch('league_teams?order=name&select=id,name,color'),
    ]);
    setDrivers(dr.data||[]);
    setTeams(tr.data||[]);
    setLoading(false);
  }

  if (!loaded) { setLoaded(true); if (sbClient) load(); else setLoading(false); }
  if (loading) return <Spinner />;

  // Count slots per team
  const teamSlots = {};
  (drivers||[]).forEach(d => {
    const tid = d.team_id;
    if (!teamSlots[tid]) teamSlots[tid] = { drivers:0, staff:0 };
    if (d.characters?.type === 'driver') teamSlots[tid].drivers++;
    else teamSlots[tid].staff++;
  });

  async function transfer(driverId, newTeamId) {
    setSaving(true);
    await sbFetch(`league_drivers?id=eq.${driverId}`, {
      method:'PATCH', body: JSON.stringify({ team_id: newTeamId })
    });
    setSaving(false);
    setTransferring(null);
    setLoaded(false); setLoading(true); load();
  }

  async function release(driverId) {
    await sbFetch(`league_drivers?id=eq.${driverId}`, { method:'DELETE' });
    setDrivers(d => d.filter(x => x.id !== driverId));
  }

  // Group by team
  const teamMap = {};
  (drivers||[]).forEach(d => {
    const tid = d.team_id;
    if (!teamMap[tid]) {
      const team = d.league_teams || teams.find(t => t.id === tid) || { id:tid, name:'Unknown', color:'#55556A' };
      teamMap[tid] = { team, members: [] };
    }
    teamMap[tid].members.push(d);
  });
  const teamGroups = Object.values(teamMap).sort((a,b) => a.team.name.localeCompare(b.team.name));
  const freeAgents = (drivers||[]).filter(d => !d.team_id);

  return (
    <div>
      {/* Slot summary */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(200px,1fr))', gap:10, marginBottom:24 }}>
        {teams.map(t => {
          const slots = teamSlots[t.id] || { drivers:0, staff:0 };
          const full = slots.drivers >= 2;
          return (
            <Card key={t.id} style={{ padding:'12px 14px' }}>
              <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:6 }}>
                <div style={{ width:4, height:28, borderRadius:2, background:t.color||'#55556A' }} />
                <div style={{ ...T.body, fontWeight:600, fontSize:13 }}>{t.name}</div>
              </div>
              <div style={{ display:'flex', gap:10 }}>
                <div>
                  <div style={{ fontSize:18, fontWeight:900, fontFamily:FONT_HEAD,
                    color: full ? '#00C46A' : '#F0F0F5' }}>{slots.drivers}/2</div>
                  <div style={{ ...T.cap, fontSize:9 }}>Drivers</div>
                </div>
                <div>
                  <div style={{ fontSize:18, fontWeight:900, fontFamily:FONT_HEAD,
                    color:'#F0F0F5' }}>{slots.staff}</div>
                  <div style={{ ...T.cap, fontSize:9 }}>Staff</div>
                </div>
                {full && <Badge color="#00C46A" style={{ alignSelf:'center', marginLeft:'auto' }}>Full</Badge>}
              </div>
            </Card>
          );
        })}
      </div>

      {/* Team rosters */}
      {teamGroups.map(({ team, members }) => (
        <div key={team.id} style={{ marginBottom:20 }}>
          <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:10 }}>
            <div style={{ width:4, height:20, borderRadius:2, background:team.color||'#55556A' }} />
            <div style={{ ...T.h3 }}>{team.name}</div>
            <div style={{ ...T.cap }}>{members.length} member{members.length!==1?'s':''}</div>
          </div>
          <Card style={{ padding:0, overflow:'hidden' }}>
            {members.map((d, i) => {
              const isTrans = transferring?.driverId === d.id;
              return (
                <div key={d.id}>
                  <div style={{ display:'flex', alignItems:'center', gap:12, padding:'11px 16px',
                    borderBottom: (i < members.length-1 || isTrans) ? '1px solid #252530' : 'none' }}>
                    <div style={{ width:34, height:34, borderRadius:'50%',
                      background:(team.color||'#55556A')+'22',
                      display:'flex', alignItems:'center', justifyContent:'center',
                      fontSize:13, fontWeight:800, color:team.color||'#55556A', fontFamily:FONT_HEAD }}>
                      {d.number || (d.characters?.name||'?')[0].toUpperCase()}
                    </div>
                    <div style={{ flex:1 }}>
                      <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                        <span style={{ ...T.body, fontWeight:600 }}>
                          {d.characters?.name || d.name || 'Unknown'}
                        </span>
                        <Badge color={d.characters?.type==='driver'?'#3B8EFF':'#FF9500'}>
                          {d.characters?.type || 'unknown'}
                        </Badge>
                      </div>
                      {d.characters?.nationality && (
                        <div style={{ ...T.cap }}>{d.characters.nationality}</div>
                      )}
                    </div>
                    <div style={{ display:'flex', gap:8 }}>
                      <Button size="sm" variant="secondary"
                        onClick={() => setTransferring({ driverId:d.id, teamId:'' })}>
                        Transfer
                      </Button>
                      <Button size="sm" variant="danger" onClick={() => release(d.id)}>
                        Release
                      </Button>
                    </div>
                  </div>
                  {isTrans && (
                    <div style={{ padding:'10px 16px', background:'#111114',
                      borderBottom: i < members.length-1 ? '1px solid #252530' : 'none' }}>
                      <Select label="Transfer to Team" value={transferring.teamId}
                        onChange={v => setTransferring(t => ({...t, teamId:v}))}
                        options={[{value:'',label:'Select team...'},
                          ...teams.filter(t => t.id !== team.id).map(t => ({value:t.id,label:t.name}))]} />
                      <div style={{ display:'flex', gap:8, marginTop:8 }}>
                        <Button size="sm" variant="success"
                          disabled={!transferring.teamId || saving}
                          onClick={() => transfer(d.id, transferring.teamId)}>
                          {saving ? 'Moving...' : 'Confirm Transfer'}
                        </Button>
                        <Button size="sm" variant="secondary" onClick={() => setTransferring(null)}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </Card>
        </div>
      ))}

      {freeAgents.length > 0 && (
        <div>
          <div style={{ ...T.h3, marginBottom:10 }}>Free Agents ({freeAgents.length})</div>
          <Card style={{ padding:0, overflow:'hidden' }}>
            {freeAgents.map((d, i) => (
              <div key={d.id} style={{ display:'flex', alignItems:'center', gap:12, padding:'11px 16px',
                borderBottom: i < freeAgents.length-1 ? '1px solid #252530' : 'none' }}>
                <div style={{ flex:1 }}>
                  <span style={{ ...T.body }}>{d.characters?.name || 'Unknown'}</span>
                  <Badge color="#55556A" style={{ marginLeft:8 }}>{d.characters?.type}</Badge>
                </div>
              </div>
            ))}
          </Card>
        </div>
      )}

      {(!drivers || drivers.length === 0) && (
        <EmptyState title="No assigned characters"
          sub="Characters appear here once assigned to a team via the Applications tab" />
      )}
    </div>
  );
}

function GMLeagueSettings() {
  const [settings, setSettings] = useState({});
  const [loading,  setLoading]  = useState(true);
  const [loaded,   setLoaded]   = useState(false);
  const [saving,     setSaving]     = useState(false);
  const [saved,      setSaved]      = useState(false);
  const [generating, setGenerating] = useState(false);
  const [genMsg,     setGenMsg]     = useState('');

  async function load() {
    const { data } = await sbFetch('league_settings?select=key,value');
    const map = {};
    (data||[]).forEach(r => { map[r.key] = r.value; });
    setSettings(map);
    setLoading(false);
  }

  if (!loaded) { setLoaded(true); if (sbClient) load(); else setLoading(false); }
  if (loading) return <Spinner />;

  const set = (k, v) => setSettings(s => ({...s, [k]: v}));

  async function save() {
    setSaving(true);
    const rows = Object.entries(settings).map(([key, value]) => ({ key, value }));
    for (const row of rows) {
      await sbFetch('league_settings', {
        method:'POST',
        headers:{ Prefer:'resolution=merge-duplicates' },
        body: JSON.stringify(row),
      });
    }
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  const F1_DEFAULTS = {
    league_name: 'F1 Sim League 2025',
    season_number: '1',
    tagline: 'The Official F1 Sim League',
    registration_open: 'open',
    max_characters: '2',
    max_drivers_per_team: '2',
    season_phase: 'pre_season',
    current_round: '1',
    total_rounds: '24',
    points_system: 'standard',
    fastest_lap_point: '1',
    dnf_penalty: '0',
    sprint_weekends: '6',
    safety_car_enabled: 'true',
    weather_enabled: 'true',
    weather_probability: '20',
    min_grid_size: '20',
    race_laps_base: '52',
  };

  function applyDefaults() {
    setSettings(s => ({ ...F1_DEFAULTS, ...s }));
  }

  const F1_2027_CALENDAR = [
    { number:-2, type:'testing', circuit_id:'bahrain',       circuit_name:'Pre-Season Test 1',   scheduled_for:'2027-02-19', is_sprint:false },
    { number:-1, type:'testing', circuit_id:'bahrain',       circuit_name:'Pre-Season Test 2',   scheduled_for:'2027-02-27', is_sprint:false },
    { number:1,  type:'race',    circuit_id:'australia',     circuit_name:'Australian GP',       scheduled_for:'2027-03-13', is_sprint:false },
    { number:2,  type:'race',    circuit_id:'china',         circuit_name:'Chinese GP',          scheduled_for:'2027-03-20', is_sprint:true  },
    { number:3,  type:'race',    circuit_id:'japan',         circuit_name:'Japanese GP',         scheduled_for:'2027-04-04', is_sprint:false },
    { number:4,  type:'race',    circuit_id:'bahrain',       circuit_name:'Bahrain GP',          scheduled_for:'2027-04-11', is_sprint:false },
    { number:5,  type:'race',    circuit_id:'saudi_arabia',  circuit_name:'Saudi Arabian GP',    scheduled_for:'2027-04-18', is_sprint:false },
    { number:6,  type:'race',    circuit_id:'miami',         circuit_name:'Miami GP',            scheduled_for:'2027-05-02', is_sprint:true  },
    { number:7,  type:'race',    circuit_id:'emilia_romagna',circuit_name:'Emilia-Romagna GP',   scheduled_for:'2027-05-16', is_sprint:false },
    { number:8,  type:'race',    circuit_id:'monaco',        circuit_name:'Monaco GP',           scheduled_for:'2027-05-23', is_sprint:false },
    { number:9,  type:'race',    circuit_id:'spain',         circuit_name:'Spanish GP',          scheduled_for:'2027-05-30', is_sprint:false },
    { number:10, type:'race',    circuit_id:'canada',        circuit_name:'Canadian GP',         scheduled_for:'2027-06-13', is_sprint:false },
    { number:11, type:'race',    circuit_id:'austria',       circuit_name:'Austrian GP',         scheduled_for:'2027-06-27', is_sprint:true  },
    { number:12, type:'race',    circuit_id:'great_britain', circuit_name:'British GP',          scheduled_for:'2027-07-04', is_sprint:false },
    { number:13, type:'race',    circuit_id:'belgium',       circuit_name:'Belgian GP',          scheduled_for:'2027-07-25', is_sprint:false },
    { number:14, type:'race',    circuit_id:'hungary',       circuit_name:'Hungarian GP',        scheduled_for:'2027-08-01', is_sprint:false },
    { number:15, type:'race',    circuit_id:'netherlands',   circuit_name:'Dutch GP',            scheduled_for:'2027-08-29', is_sprint:false },
    { number:16, type:'race',    circuit_id:'italy',         circuit_name:'Italian GP',          scheduled_for:'2027-09-05', is_sprint:false },
    { number:17, type:'race',    circuit_id:'azerbaijan',    circuit_name:'Azerbaijan GP',       scheduled_for:'2027-09-19', is_sprint:false },
    { number:18, type:'race',    circuit_id:'singapore',     circuit_name:'Singapore GP',        scheduled_for:'2027-10-03', is_sprint:false },
    { number:19, type:'race',    circuit_id:'usa',           circuit_name:'United States GP',    scheduled_for:'2027-10-17', is_sprint:true  },
    { number:20, type:'race',    circuit_id:'mexico',        circuit_name:'Mexico City GP',      scheduled_for:'2027-10-24', is_sprint:false },
    { number:21, type:'race',    circuit_id:'brazil',        circuit_name:'Brazilian GP',        scheduled_for:'2027-11-07', is_sprint:true  },
    { number:22, type:'race',    circuit_id:'las_vegas',     circuit_name:'Las Vegas GP',        scheduled_for:'2027-11-20', is_sprint:false },
    { number:23, type:'race',    circuit_id:'qatar',         circuit_name:'Qatar GP',            scheduled_for:'2027-11-28', is_sprint:true  },
    { number:24, type:'race',    circuit_id:'abu_dhabi',     circuit_name:'Abu Dhabi GP',        scheduled_for:'2027-12-05', is_sprint:false },
  ];

  async function generateCalendar() {
    setGenerating(true); setGenMsg('');
    const { data: existing } = await sbFetch('rounds?select=id');
    if (existing && existing.length > 0) {
      const confirmed = window.confirm(
        `${existing.length} round(s) already exist.\n\nReplace all with the full 2027 F1 calendar (2 testing + 24 races)?\n\nThis cannot be undone.`
      );
      if (!confirmed) { setGenerating(false); return; }
      await sbFetch('rounds?id=neq.00000000-0000-0000-0000-000000000000', { method:'DELETE' });
    }
    let ok = 0;
    for (const r of F1_2027_CALENDAR) {
      const res = await sbFetch('rounds', {
        method:'POST',
        headers:{ Prefer:'return=minimal' },
        body: JSON.stringify({ ...r, state:'scheduled' }),
      });
      if (!res.error) ok++;
    }
    setGenerating(false);
    setGenMsg(`✓ Generated ${ok}/${F1_2027_CALENDAR.length} rounds (2 testing + 24 races)`);
  }

  return (
    <div>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:8 }}>
        <div style={{ ...T.h3 }}>League Settings</div>
        <div style={{ display:'flex', gap:10 }}>
          <Button variant="secondary" onClick={applyDefaults}>Apply F1 Defaults</Button>
          <Button variant="secondary" onClick={generateCalendar} disabled={generating}>
            {generating ? 'Generating...' : 'Generate 2027 Calendar'}
          </Button>
          <Button onClick={save} disabled={saving}>
            {saved ? 'Saved ✓' : saving ? 'Saving...' : 'Save Changes'}
          </Button>
        </div>
      </div>
      <div style={{ display:'flex', gap:16, alignItems:'center', marginBottom:20 }}>
        <div style={{ ...T.cap, color:'#55556A' }}>
          "Apply F1 Defaults" pre-fills empty fields · "Generate 2027 Calendar" inserts 2 testing + 24 race rounds
        </div>
        {genMsg && <div style={{ ...T.cap, color:'#00C46A', fontSize:11 }}>{genMsg}</div>}
      </div>

      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:20 }}>
        {/* Identity */}
        <Card>
          <div style={{ ...T.cap, color:'#E8002D', marginBottom:12 }}>Identity</div>
          <Input label="League Name" value={settings.league_name||''} onChange={v => set('league_name',v)}
            placeholder="e.g. F1 Sim League 2027" />
          <Input label="Season Number" value={settings.season_number||''} onChange={v => set('season_number',v)}
            placeholder="e.g. 1" />
          <Input label="Tagline" value={settings.tagline||''} onChange={v => set('tagline',v)}
            placeholder="e.g. The Official F1 Sim League" />
        </Card>

        {/* Registration */}
        <Card>
          <div style={{ ...T.cap, color:'#3B8EFF', marginBottom:12 }}>Registration</div>
          <Select label="Applications Status"
            value={settings.registration_open||'open'}
            onChange={v => set('registration_open',v)}
            options={[
              { value:'open',   label:'Open - new applications accepted' },
              { value:'review', label:'Review only - no new apps' },
              { value:'closed', label:'Closed - locked' },
            ]} />
          <Input label="Max Characters per Player" value={settings.max_characters||''}
            onChange={v => set('max_characters',v)} placeholder="e.g. 2" />
          <Input label="Max Drivers per Team" value={settings.max_drivers_per_team||''}
            onChange={v => set('max_drivers_per_team',v)} placeholder="e.g. 2" />
        </Card>

        {/* Season state */}
        <Card>
          <div style={{ ...T.cap, color:'#FF9500', marginBottom:12 }}>Season State</div>
          <Select label="Season Phase"
            value={settings.season_phase||'pre_season'}
            onChange={v => set('season_phase',v)}
            options={[
              { value:'pre_season',  label:'Pre-Season' },
              { value:'active',      label:'Active - season running' },
              { value:'mid_break',   label:'Mid-Season Break' },
              { value:'post_season', label:'Post-Season' },
              { value:'off_season',  label:'Off-Season' },
            ]} />
          <Input label="Current Round" value={settings.current_round||''}
            onChange={v => set('current_round',v)} placeholder="e.g. 3" />
          <Input label="Total Rounds" value={settings.total_rounds||''}
            onChange={v => set('total_rounds',v)} placeholder="e.g. 24" />
        </Card>

        {/* Scoring */}
        <Card>
          <div style={{ ...T.cap, color:'#FFD700', marginBottom:12 }}>Scoring System</div>
          <Select label="Points System"
            value={settings.points_system||'standard'}
            onChange={v => set('points_system',v)}
            options={[
              { value:'standard',    label:'Standard F1 (25-18-15...)' },
              { value:'sprint_bonus',label:'Sprint bonus included' },
              { value:'custom',      label:'Custom (edit manually)' },
            ]} />
          <Input label="Fastest Lap Point" value={settings.fastest_lap_point||''}
            onChange={v => set('fastest_lap_point',v)} placeholder="1 (optional)" />
          <Input label="DNF Penalty" value={settings.dnf_penalty||''}
            onChange={v => set('dnf_penalty',v)} placeholder="e.g. 0 (no penalty)" />
        </Card>

        {/* Race Format */}
        <Card>
          <div style={{ ...T.cap, color:'#00C46A', marginBottom:12 }}>Race Format</div>
          <Input label="Total Rounds" value={settings.total_rounds||''}
            onChange={v => set('total_rounds',v)} placeholder="e.g. 24" />
          <Input label="Sprint Weekends (count)" value={settings.sprint_weekends||''}
            onChange={v => set('sprint_weekends',v)} placeholder="e.g. 6" />
          <Input label="Base Lap Count" value={settings.race_laps_base||''}
            onChange={v => set('race_laps_base',v)} placeholder="e.g. 52" />
          <Input label="Minimum Grid Size" value={settings.min_grid_size||''}
            onChange={v => set('min_grid_size',v)} placeholder="e.g. 20 (AI-padded if needed)" />
        </Card>

        {/* Simulation */}
        <Card>
          <div style={{ ...T.cap, color:'#9B59B6', marginBottom:12 }}>Simulation Rules</div>
          <div style={{ marginBottom:14 }}>
            <label style={{ ...T.cap, color:'#8888A0', display:'flex', alignItems:'center', gap:10, cursor:'pointer' }}>
              <input type="checkbox"
                checked={settings.safety_car_enabled === 'true'}
                onChange={e => set('safety_car_enabled', e.target.checked ? 'true' : 'false')}
                style={{ width:16, height:16, accentColor:'#E8002D' }} />
              Safety Car enabled
            </label>
          </div>
          <div style={{ marginBottom:14 }}>
            <label style={{ ...T.cap, color:'#8888A0', display:'flex', alignItems:'center', gap:10, cursor:'pointer' }}>
              <input type="checkbox"
                checked={settings.weather_enabled === 'true'}
                onChange={e => set('weather_enabled', e.target.checked ? 'true' : 'false')}
                style={{ width:16, height:16, accentColor:'#E8002D' }} />
              Dynamic weather enabled
            </label>
          </div>
          {settings.weather_enabled === 'true' && (
            <div style={{ marginBottom:14 }}>
              <label style={{ ...T.cap, color:'#8888A0', display:'block', marginBottom:6 }}>
                Rain probability — {settings.weather_probability||20}%
              </label>
              <input type="range" min={0} max={100} step={5}
                value={Number(settings.weather_probability||20)}
                onChange={e => set('weather_probability', e.target.value)}
                style={{ width:'100%', accentColor:'#3B8EFF' }} />
            </div>
          )}
        </Card>
      </div>

      {/* Current values preview */}
      <Card style={{ marginTop:20 }}>
        <div style={{ ...T.cap, color:'#55556A', marginBottom:10 }}>Current DB Values</div>
        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(200px,1fr))', gap:8 }}>
          {Object.entries(settings).map(([k,v]) => (
            <div key={k} style={{ background:'#111114', borderRadius:6, padding:'8px 10px' }}>
              <div style={{ ...T.cap, color:'#55556A' }}>{k.replace(/_/g,' ')}</div>
              <div style={{ ...T.body, fontSize:13, fontWeight:600 }}>{String(v)}</div>
            </div>
          ))}
          {Object.keys(settings).length === 0 && (
            <div style={{ ...T.sub }}>No settings saved yet. Fill in the form above and click Save.</div>
          )}
        </div>
      </Card>
    </div>
  );
}

function GMAuditLog() {
  const [log, setLog] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);

  if (!loaded) {
    setLoaded(true);
    if (sbClient) {
      sbFetch('audit_log?order=at.desc&limit=100&select=*,profiles!actor_id(username)')
        .then(({ data }) => { setLog(data || []); setLoading(false); });
    } else setLoading(false);
  }

  if (loading) return <Spinner />;
  if (!log || log.length === 0) return <EmptyState title="No audit entries" />;

  return (
    <div>
      <div style={{ ...T.h2, marginBottom:14 }}>Audit Log</div>
      <Card style={{ padding:0, overflow:'hidden' }}>
        {log.map((e, i) => (
          <div key={e.id} style={{ padding:'10px 16px',
            borderBottom: i < log.length-1 ? '1px solid #252530' : 'none',
            display:'grid', gridTemplateColumns:'160px 1fr auto', gap:12, alignItems:'center' }}>
            <div style={{ ...T.cap }}>{new Date(e.at).toLocaleString()}</div>
            <div>
              <span style={{ ...T.body, fontWeight:600 }}>{e.action}</span>
              <span style={{ ...T.sub }}> - {e.entity}{e.entity_id ? ` (${e.entity_id.slice(0,8)}...)` : ''}</span>
            </div>
            <div style={{ ...T.sub }}>{e.profiles?.username || '-'}</div>
          </div>
        ))}
      </Card>
    </div>
  );
}

// -- GM Race Control ----------------------------------------------------------

function GMRaceControl({ sbUser }) {
  const [track,         setTrack]         = useState(TRACKS[0]);
  const [n,             setN]             = useState(5);
  const [mode,          setMode]          = useState('qualifying');
  const [results,       setResults]       = useState(null);
  const [running,       setRunning]       = useState(false);
  const [rounds,        setRounds]        = useState([]);
  const [allRounds,     setAllRounds]     = useState([]);
  const [selectedRound, setSelectedRound] = useState('');
  const [loaded,        setLoaded]        = useState(false);
  const [leagueMode,    setLeagueMode]    = useState(false);
  const [leagueDrivers, setLeagueDrivers] = useState([]);
  const [leagueTeams,   setLeagueTeams]   = useState([]);
  const [loadingLeague, setLoadingLeague] = useState(false);
  const [creating,      setCreating]      = useState(false);
  const [newRound,      setNewRound]      = useState({ circuit_id:'', circuit_name:'', number:'', scheduled_for:'', is_sprint:false });
  const [savingRound,   setSavingRound]   = useState(false);
  const [advancing,     setAdvancing]     = useState(null);
  const [tab,           setTab]           = useState('sim');
  const [simError,      setSimError]      = useState('');

  async function loadRounds() {
    const { data } = await sbFetch('rounds?order=number&select=*');
    setAllRounds(data||[]);
    setRounds((data||[]).filter(r => ['locked','orders_open'].includes(r.state)));
  }

  if (!loaded) { setLoaded(true); if (sbClient) loadRounds(); }

  // Map a free-form driving style string to one of the engine's style IDs
  function mapDrivingStyle(ds) {
    if (!ds) return 'technical';
    const lower = ds.toLowerCase();
    const ENGINE_STYLES = ['charger','technical','smooth','aggressive','qualifier','defender','strategist','ironman'];
    return ENGINE_STYLES.find(s => lower.includes(s)) || 'technical';
  }

  // Parse a comma-separated track name string into engine track IDs
  function parseTrackIds(str) {
    if (!str) return [];
    return str.split(',').map(s => {
      const q = s.trim().toLowerCase().replace(/[^a-z]/g,'');
      const hit = TRACKS.find(t =>
        t.id === q ||
        t.name.toLowerCase().replace(/[^a-z]/g,'').includes(q) ||
        q.includes(t.id)
      );
      return hit ? hit.id : null;
    }).filter(Boolean);
  }

  // Build a 3-letter abbreviation from last name (Smith → SMI)
  function makeAbbr(name) {
    const parts = (name||'').trim().split(/\s+/);
    const last  = parts[parts.length - 1] || parts[0] || '???';
    return last.substring(0, 3).toUpperCase();
  }

  async function loadLeagueData() {
    setLoadingLeague(true);
    const [dr, tr] = await Promise.all([
      sbFetch('league_drivers?select=*,characters(name,number,pace,consistency,wet,overtaking,defense,experience,mental,driving_style,sim_style,good_tracks,bad_tracks),league_teams(id,name,color,car_pace,reliability,pit_speed,tyre_life,strategy)'),
      sbFetch('league_teams?select=*'),
    ]);
    const rawDrivers = (dr.data||[]).filter(d => d.characters);
    const rawTeams   = tr.data||[];

    // Map to engine format
    const engTeams = rawTeams.map(t => ({
      id: t.id, tier: t.tier||'mid',
      strategy: t.strategy || 'reactive',
      name: t.name, abbr:(t.name||'UNK').substring(0,3).toUpperCase(),
      color: t.color||'#888888', tc:'#fff',
      basePitSpeed: t.pit_speed||80, carPace:t.car_pace||70,
      reliability:t.reliability||75, pitSpeed:t.pit_speed||80,
      tyreLife:t.tyre_life||70, cornering:10, topSpeed:10,
    }));

    const engDrivers = rawDrivers.map(d => {
      const c   = d.characters;
      const tid = d.league_teams?.id || d.team_id;
      return {
        id:          d.id.slice(0, 8),
        name:        c.name,
        abbr:        makeAbbr(c.name),
        num:         d.number || c.number || 99,
        teamId:      tid,
        pace:        c.pace        || 70,
        consistency: c.consistency || 70,
        wet:         c.wet         || 70,
        overtaking:  c.overtaking  || 70,
        defense:     c.defense     || 70,
        experience:  c.experience  || 50,
        mental:      c.mental      || 7,
        style:       c.sim_style || mapDrivingStyle(c.driving_style),
        goodTracks:  parseTrackIds(c.good_tracks),
        badTracks:   parseTrackIds(c.bad_tracks),
        rivals:      [],
      };
    });

    setLeagueDrivers(engDrivers);
    setLeagueTeams(engTeams);
    setLoadingLeague(false);
  }

  function buildSimGrid(realDrivers, realTeams) {
    const MIN = 20;
    if (realDrivers.length >= MIN) return { drivers: realDrivers, teams: realTeams };
    const needed = MIN - realDrivers.length;
    const usedIds = new Set(realDrivers.map(d => d.id));
    const aiDrivers = DRIVERS.filter(d => !usedIds.has(d.id)).slice(0, needed).map(d => ({
      ...d, name: `[AI] ${d.name}`, id: `ai_${d.id}`,
    }));
    const aiTeamIds = new Set(aiDrivers.map(d => d.teamId));
    const aiTeams   = TEAMS.filter(t => aiTeamIds.has(t.id));
    return {
      drivers: [...realDrivers, ...aiDrivers],
      teams:   [...realTeams, ...aiTeams],
    };
  }

  function runSim() {
    let driverList = leagueMode && leagueDrivers.length > 0 ? leagueDrivers : DRIVERS;
    let teamList   = leagueMode && leagueTeams.length > 0   ? leagueTeams   : TEAMS;

    if (leagueMode) {
      const padded = buildSimGrid(driverList, teamList);
      driverList = padded.drivers;
      teamList   = padded.teams;
    }

    setSimError('');
    setRunning(true);
    setTimeout(() => {
      try {
        if (mode === 'qualifying') {
          const raw = aggQual(n, driverList, teamList, track);
          setResults((raw.grid || []).map((e, i) => ({
            pos: i+1,
            driver: e.driver?.name || '',
            team:   e.team?.name   || '',
            time:   e.score ? e.score.toFixed(3) : '',
          })));
        } else {
          const qualResult = aggQual(1, driverList, teamList, track);
          const raw = aggRace(n, qualResult.grid, teamList, track);
          setResults((raw.positions || []).map((e, i) => ({
            pos:    i+1,
            driver: e.driver?.name || '',
            team:   e.team?.name   || '',
            dnf:    e.dnf || false,
            time:   e.dnf ? 'DNF' : (i === 0 ? 'WINNER' : (e.gap != null ? `+${e.gap.toFixed(3)}s` : '')),
          })));
        }
      } catch(err) {
        setSimError(String(err?.message || err));
      }
      setRunning(false);
    }, 50);
  }

  async function publishResults(status) {
    if (!selectedRound || !results) return;
    await sbFetch('session_runs', {
      method:'POST',
      body: JSON.stringify({
        round_id: selectedRound, session: mode, attempt:1,
        seed: Date.now(), mode: n > 1 ? 'averaged' : 'single',
        run_count: n, result: { placements: results }, status, run_by: sbUser.id,
        league_mode: leagueMode,
      })
    });
    if (status === 'final') {
      // Advance round to complete
      await sbFetch(`rounds?id=eq.${selectedRound}`, {
        method:'PATCH', body: JSON.stringify({ state:'complete' })
      });
      loadRounds();
    }
  }

  async function createRound() {
    if (!newRound.circuit_id || !newRound.number) return;
    setSavingRound(true);
    const track = TRACKS.find(t => t.id === newRound.circuit_id);
    await sbFetch('rounds', {
      method:'POST',
      body: JSON.stringify({
        number:        parseInt(newRound.number),
        circuit_id:    newRound.circuit_id,
        circuit_name:  track?.name || newRound.circuit_id,
        state:         'scheduled',
        is_sprint:     newRound.is_sprint,
        scheduled_for: newRound.scheduled_for || null,
      })
    });
    setSavingRound(false);
    setCreating(false);
    setNewRound({ circuit_id:'', circuit_name:'', number:'', scheduled_for:'', is_sprint:false });
    loadRounds();
  }

  const STATE_PIPELINE = ['scheduled','orders_open','locked','in_progress','complete'];
  const STATE_LABEL    = { scheduled:'Scheduled', orders_open:'Orders Open', locked:'Locked',
    in_progress:'In Progress', complete:'Complete' };
  const STATE_COLOR    = { scheduled:'#55556A', orders_open:'#3B8EFF', locked:'#FF9500',
    in_progress:'#E8002D', complete:'#00C46A' };
  function nextState(s) {
    const i = STATE_PIPELINE.indexOf(s);
    return i >= 0 && i < STATE_PIPELINE.length-1 ? STATE_PIPELINE[i+1] : null;
  }
  async function advanceState(r) {
    const next = nextState(r.state);
    if (!next) return;
    setAdvancing(r.id);
    await sbFetch(`rounds?id=eq.${r.id}`, { method:'PATCH', body: JSON.stringify({ state:next }) });
    setAdvancing(null);
    loadRounds();
  }

  return (
    <div>
      <div style={{ display:'flex', gap:4, marginBottom:20 }}>
        {[['sim','Simulator'],['rounds','Round Management']].map(([id,label]) => (
          <button key={id} onClick={() => setTab(id)}
            style={{ padding:'8px 18px', border:'none', borderRadius:6, fontSize:13, fontWeight:600,
              cursor:'pointer', background: tab === id ? '#E8002D' : '#111114',
              color: tab === id ? '#fff' : '#8888A0', fontFamily:FONT_BODY }}>
            {label}
          </button>
        ))}
      </div>

      {/* ── Simulator tab ── */}
      {tab === 'sim' && (
        <div>
          {/* League mode toggle */}
          <div style={{ marginBottom:16, padding:'12px 16px', background:'#111114',
            borderRadius:8, display:'flex', justifyContent:'space-between', alignItems:'center' }}>
            <div>
              <div style={{ ...T.body, fontWeight:600 }}>
                {leagueMode ? 'League Mode' : 'Engine Mode'}
              </div>
              <div style={{ ...T.sub, fontSize:12 }}>
                {leagueMode
                  ? leagueDrivers.length < 20
                    ? `${leagueDrivers.length} league driver${leagueDrivers.length !== 1 ? 's' : ''} + ${20 - leagueDrivers.length} AI fill drivers`
                    : `Using ${leagueDrivers.length} league drivers from DB`
                  : 'Using built-in F1 2027 engine drivers'}
              </div>
            </div>
            <div style={{ display:'flex', gap:8, alignItems:'center' }}>
              {!leagueMode ? (
                <Button size="sm" onClick={() => { setLeagueMode(true); loadLeagueData(); }}
                  disabled={loadingLeague}>
                  {loadingLeague ? 'Loading...' : 'Switch to League'}
                </Button>
              ) : (
                <Button size="sm" variant="secondary" onClick={() => setLeagueMode(false)}>
                  Switch to Engine
                </Button>
              )}
            </div>
          </div>

          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:14, marginBottom:16 }}>
            <Card>
              <div style={{ ...T.cap, marginBottom:10 }}>Session Settings</div>
              <Select label="Mode" value={mode} onChange={setMode}
                options={[{ value:'qualifying', label:'Qualifying' }, { value:'race', label:'Race' }]} />
              <Select label="Circuit" value={track.id}
                onChange={id => setTrack(TRACKS.find(t => t.id === id) || TRACKS[0])}
                options={TRACKS.map(t => ({ value:t.id, label:t.name }))} />
              <div style={{ marginBottom:14 }}>
                <div style={{ display:'flex', justifyContent:'space-between', marginBottom:4 }}>
                  <span style={{ ...T.cap }}>Simulations: {n}</span>
                </div>
                <input type="range" min={1} max={25} value={n}
                  onChange={e => setN(parseInt(e.target.value))}
                  style={{ width:'100%', accentColor:'#E8002D' }} />
              </div>
              <Button onClick={runSim} disabled={running || (leagueMode && leagueDrivers.length === 0)}
                style={{ width:'100%' }}>
                {running ? 'Running...' : `Run ${mode}`}
              </Button>
            </Card>

            <Card>
              <div style={{ ...T.cap, marginBottom:10 }}>Publish</div>
              {rounds.length > 0 ? (
                <Select label="Link to Round" value={selectedRound} onChange={setSelectedRound}
                  options={[{ value:'', label:'Select round...' },
                    ...rounds.map(r => ({ value:r.id, label:`R${r.number} - ${r.circuit_name||r.circuit_id}` }))]} />
              ) : (
                <div style={{ ...T.sub, fontSize:12, marginBottom:14 }}>No active rounds</div>
              )}
              <div style={{ display:'flex', gap:8 }}>
                <Button variant="secondary" disabled={!results || !selectedRound}
                  onClick={() => publishResults('provisional')}>
                  Provisional
                </Button>
                <Button variant="success" disabled={!results || !selectedRound}
                  onClick={() => publishResults('final')}>
                  Confirm Final
                </Button>
              </div>
              {results && selectedRound && (
                <div style={{ ...T.sub, fontSize:11, marginTop:8 }}>
                  "Confirm Final" saves results and advances round to Complete.
                </div>
              )}
            </Card>
          </div>

          {simError && (
            <div style={{ background:'rgba(232,0,45,0.1)', border:'1px solid #E8002D',
              borderRadius:7, padding:'12px 16px', marginBottom:16, fontSize:13,
              color:'#FF6644', fontFamily:FONT_MONO, whiteSpace:'pre-wrap' }}>
              Simulation error: {simError}
            </div>
          )}

          {results && (
            <Card style={{ padding:0, overflow:'hidden' }}>
              <div style={{ padding:'10px 16px', background:'#111114',
                borderBottom:'1px solid #252530', ...T.cap }}>
                Results &mdash; {track.name} {mode}
                {leagueMode && <span style={{ color:'#3B8EFF', marginLeft:8 }}>(League)</span>}
              </div>
              {results.map((r, i) => (
                <div key={i} style={{ display:'grid', gridTemplateColumns:'40px 1fr auto',
                  padding:'10px 16px', borderBottom:'1px solid #252530', alignItems:'center' }}>
                  <div style={{ fontWeight:900, fontFamily:FONT_HEAD,
                    color: i<3 ? ['#FFD700','#C0C0C0','#CD7F32'][i] : '#55556A' }}>P{i+1}</div>
                  <div style={{ ...T.body }}>{r.driver || r.name || r.abbr || ''}</div>
                  <div style={{ ...T.sub }}>{r.time || r.lapTime || r.teamId || ''}</div>
                </div>
              ))}
            </Card>
          )}
        </div>
      )}

      {/* ── Round Management tab ── */}
      {tab === 'rounds' && (
        <div>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:16 }}>
            <div style={{ ...T.h3 }}>All Rounds</div>
            <Button onClick={() => setCreating(!creating)}>+ New Round</Button>
          </div>

          {creating && (
            <Card style={{ marginBottom:20 }}>
              <div style={{ ...T.cap, color:'#E8002D', marginBottom:10 }}>Create Round</div>
              <Input label="Round Number" value={newRound.number}
                onChange={v => setNewRound(f => ({...f,number:v}))} placeholder="e.g. 1" />
              <Select label="Circuit" value={newRound.circuit_id}
                onChange={v => setNewRound(f => ({...f, circuit_id:v}))}
                options={[{value:'',label:'Select circuit...'},
                  ...TRACKS.map(t => ({value:t.id,label:t.name}))]} />
              <Input label="Date (optional)" value={newRound.scheduled_for}
                onChange={v => setNewRound(f => ({...f,scheduled_for:v}))}
                placeholder="YYYY-MM-DD" />
              <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:14 }}>
                <label style={{ ...T.cap }}>Sprint Weekend</label>
                <input type="checkbox" checked={newRound.is_sprint}
                  onChange={e => setNewRound(f => ({...f,is_sprint:e.target.checked}))}
                  style={{ width:16, height:16, accentColor:'#FF9500' }} />
              </div>
              <div style={{ display:'flex', gap:10 }}>
                <Button onClick={createRound} disabled={savingRound}>
                  {savingRound ? 'Creating...' : 'Create Round'}
                </Button>
                <Button variant="secondary" onClick={() => setCreating(false)}>Cancel</Button>
              </div>
            </Card>
          )}

          {allRounds.length === 0 && !creating && (
            <EmptyState title="No rounds yet" sub="Create the first round above" />
          )}
          <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
            {allRounds.map(r => (
              <Card key={r.id}>
                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                  <div style={{ display:'flex', gap:14, alignItems:'center' }}>
                    <div style={{ fontWeight:900, fontSize:18, fontFamily:FONT_HEAD,
                      color: STATE_COLOR[r.state]||'#55556A', minWidth:36 }}>R{r.number}</div>
                    <div>
                      <div style={{ ...T.h3 }}>{r.circuit_name||r.circuit_id}</div>
                      <div style={{ display:'flex', gap:6, alignItems:'center' }}>
                        <Badge color={STATE_COLOR[r.state]||'#55556A'}>
                          {STATE_LABEL[r.state]||r.state}
                        </Badge>
                        {r.is_sprint && <Badge color="#FF9500">Sprint</Badge>}
                      </div>
                    </div>
                  </div>
                  {nextState(r.state) && (
                    <Button size="sm" variant="secondary"
                      onClick={() => advanceState(r)}
                      disabled={advancing === r.id}>
                      {advancing === r.id ? '...' : `-> ${STATE_LABEL[nextState(r.state)]}`}
                    </Button>
                  )}
                </div>
              </Card>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// -- Sandbox ------------------------------------------------------------------

function SandboxPage() {
  const [track, setTrack] = useState(TRACKS[0]);
  const [n, setN] = useState(5);
  const [mode, setMode] = useState('qualifying');
  const [results, setResults] = useState(null);
  const [running, setRunning] = useState(false);
  const [simError, setSimError] = useState('');

  function run() {
    setSimError('');
    setRunning(true);
    setTimeout(() => {
      try {
        if (mode === 'qualifying') {
          const raw = aggQual(n, DRIVERS, TEAMS, track);
          setResults((raw.grid||[]).map((e,i) => ({
            pos:i+1, driver:e.driver?.name||'', team:e.team?.name||'',
            time:e.score?e.score.toFixed(3):'',
          })));
        } else {
          const qr = aggQual(1, DRIVERS, TEAMS, track);
          const raw = aggRace(n, qr.grid, TEAMS, track);
          setResults((raw.positions||[]).map((e,i) => ({
            pos:i+1, driver:e.driver?.name||'', team:e.team?.name||'',
            dnf:e.dnf||false,
            time:e.dnf?'DNF':(i===0?'WINNER':(e.gap!=null?`+${e.gap.toFixed(3)}s`:'')),
          })));
        }
      } catch(err) {
        setSimError(String(err?.message || err));
      }
      setRunning(false);
    }, 50);
  }

  return (
    <div>
      <div style={{ ...T.h1, marginBottom:8 }}>Sandbox</div>
      <div style={{ ...T.sub, marginBottom:24 }}>Test the simulation engine with default data</div>
      <div style={{ display:'flex', gap:14, flexWrap:'wrap', marginBottom:16 }}>
        <Card style={{ flex:'0 0 280px' }}>
          <Select label="Mode" value={mode} onChange={setMode}
            options={[{ value:'qualifying', label:'Qualifying' }, { value:'race', label:'Race' }]} />
          <Select label="Circuit" value={track.id} onChange={id => setTrack(TRACKS.find(t => t.id === id) || TRACKS[0])}
            options={TRACKS.map(t => ({ value:t.id, label:t.name }))} />
          <div style={{ marginBottom:14 }}>
            <div style={{ ...T.cap, marginBottom:4 }}>Runs: {n}</div>
            <input type="range" min={1} max={25} value={n}
              onChange={e => setN(parseInt(e.target.value))}
              style={{ width:'100%', accentColor:'#E8002D' }} />
          </div>
          <Button onClick={run} disabled={running} style={{ width:'100%' }}>
            {running ? 'Running...' : 'Run Simulation'}
          </Button>
          {simError && (
            <div style={{ marginTop:10, padding:'10px 12px', background:'rgba(232,0,45,0.1)',
              border:'1px solid #E8002D', borderRadius:6, fontSize:12,
              color:'#FF6644', fontFamily:FONT_MONO, whiteSpace:'pre-wrap' }}>
              {simError}
            </div>
          )}
        </Card>
        {results && (
          <Card style={{ flex:'1 1 300px', padding:0, overflow:'hidden' }}>
            <div style={{ padding:'10px 16px', background:'#111114', borderBottom:'1px solid #252530', ...T.cap }}>
              {track.name} - {mode}
            </div>
            {results.slice(0,20).map((r, i) => (
              <div key={i} style={{ display:'grid', gridTemplateColumns:'36px 1fr auto',
                padding:'9px 16px', borderBottom:'1px solid #252530', alignItems:'center' }}>
                <div style={{ fontWeight:800, fontSize:14, color: i<3 ? ['#FFD700','#C0C0C0','#CD7F32'][i] : '#55556A' }}>P{i+1}</div>
                <div style={{ ...T.body }}>{r.driver || r.name || r.abbr || ''}</div>
                <div style={{ ...T.sub }}>{r.time || r.lapTime || r.teamId || ''}</div>
              </div>
            ))}
          </Card>
        )}
      </div>
    </div>
  );
}

// -- Main App -----------------------------------------------------------------

export default function F1Sim() {
  const [sbUser, setSbUser] = useState(null);
  const [profile, setProfile] = useState(null);
  const [page, setPage] = useState('dashboard');
  const [navTarget, setNavTarget] = useState(null);
  const [authLoading, setAuthLoading] = useState(!!sbClient);
  const [unreadCount, setUnreadCount] = useState(0);
  const authInitRef = useRef(false);

  if (sbClient && !authInitRef.current) {
    authInitRef.current = true;
    sbClient.auth.getSession().then(({ data: { session } }) => {
      if (session?.user) {
        setSbUser(session.user);
        loadProfile(session.user.id);
      } else {
        setAuthLoading(false);
      }
    }).catch(() => setAuthLoading(false));
  }

  async function loadProfile(uid) {
    try {
      const { data } = await sbFetch(`profiles?id=eq.${uid}&select=*&limit=1`);
      if (data && data[0]) {
        let p = data[0];
        // Ensure league owner always has GM role
        if (p.username && p.username.toLowerCase() === GM_USERNAME && p.role !== 'gm') {
          await sbFetch(`profiles?id=eq.${uid}`, {
            method: 'PATCH', body: JSON.stringify({ role: 'gm' })
          });
          p = { ...p, role: 'gm' };
        }
        setProfile(p);
        const { data: notifs } = await sbFetch(`notifications?recipient_id=eq.${uid}&read_at=is.null&select=id`);
        setUnreadCount((notifs || []).length);
      }
    } finally {
      setAuthLoading(false);
    }
  }

  function handleLogin(user) {
    setSbUser(user);
    loadProfile(user.id);
  }

  if (authLoading) return (
    <div style={{ minHeight:'100vh', background:'#0A0A0C', display:'flex',
      alignItems:'center', justifyContent:'center',
      fontFamily:FONT_BODY }}>
      <Spinner />
    </div>
  );

  if (!sbUser) return <AuthScreen onLogin={handleLogin} />;

  const pageProps = { sbUser, profile, setPage, navTarget, setNavTarget, onProfileUpdate: setProfile };

  const renderPage = () => {
    switch (page) {
      case 'dashboard':     return <Dashboard {...pageProps} />;
      case 'characters':    return <CharactersPage {...pageProps} />;
      case 'team':          return <MyTeamPage {...pageProps} />;
      case 'apply':         return <ApplyPage {...pageProps} />;
      case 'teams':         return <TeamsPage />;
      case 'championship':  return <ChampionshipPage {...pageProps} />;
      case 'calendar':      return <CalendarPage {...pageProps} />;
      case 'stats':         return <StatsPage {...pageProps} />;
      case 'notifications': return <NotificationsPage {...pageProps} onRead={() => setUnreadCount(0)} />;
      case 'settings':      return <SettingsPage {...pageProps} />;
      case 'gm':            return <GMControlPage {...pageProps} />;
      case 'search':         return <SearchPage {...pageProps} />;
      case 'profile':        return <PublicProfilePage {...pageProps} />;
      case 'sandbox':       return <SandboxPage />;
      default:              return <Dashboard {...pageProps} />;
    }
  };

  return (
    <div style={{ display:'flex', minHeight:'100vh', background:'#0A0A0C',
      fontFamily:FONT_BODY, color:'#F0F0F5' }}>
      <Sidebar page={page} setPage={setPage} profile={profile} unreadCount={unreadCount} />
      <main style={{ flex:1, padding:'28px 32px', overflowY:'auto', maxHeight:'100vh' }}>
        <ErrorBoundary>
          {renderPage()}
        </ErrorBoundary>
      </main>
    </div>
  );
}
