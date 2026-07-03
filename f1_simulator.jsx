/**
 * F1 SIM 2027 — Formula 1 Season Simulator
 * React 19 JSX, single-file PWA, localStorage persistence
 * Commentary via Anthropic claude-sonnet-4
 */

import { useState, useRef } from "react";

// ===================== DATA =====================


// ── Car stats are set directly on each team via sliders ─────────────────────
// Fields: carPace, reliability, pitSpeed, tyreLife, cornering, topSpeed

// (PARTS catalogue removed — stats are now set directly via sliders)

// Derive effective team stats — reads direct slider fields
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




// ── Budget tier configuration ────────────────────────────────────────────────
const TIER_CONFIG = {
  top: {label:"TOP TEAM",   color:"#E8002D", startCap:25, capPerRound:6, desc:"Leading constructor · Full factory resources"},
  mid: {label:"MID-FIELD",  color:"#FFC906", startCap:15, capPerRound:4, desc:"Independent constructor · Focused development"},
  low: {label:"BACKMARKER", color:"#778899", startCap:12, capPerRound:2, desc:"New or developing team · Limited budget"},
};

function initBudgets() {
  return Object.fromEntries(TEAMS.map(t=>[t.id, (TIER_CONFIG[t.tier]||TIER_CONFIG.low).startCap]));
}

// ║  Defines 8 race strategy archetypes. Each strategy carries numeric      ║
// ║  directly into runRace() and runSprint(). Teams are assigned a default  ║
// ║                                                                          ║
// ║  Overcut Gamble · Fuel Saving Mode · Safety Car Hunter · Tyre Banker    ║
// ===================== TEAM STRATEGIES =====================
const TEAM_STRATEGIES = [
  {
    id:"one_stop",    name:"One-Stop Master",  icon:"🎯", color:"#44CC88",
    desc:"Commit to a single pit stop. Maximise track position, nurse tyres to the end.",
    effects:"Pit stops: 1 · Tyre deg management +15% · Position gain from undercut −80% · Effective when safety car unlikely",
    mods:{pitStops:1,tyreBonus:1.15,undercutPenalty:0.2,overallPace:0.98,dnfRisk:-0.03,scBonus:1.2},
    lapNotes:["Managing the rubber carefully","Trying to make it to the end on this set","The long stints will define their race"],
  },
  {
    id:"aggressive_two","name":"Aggressive 2-Stop",icon:"🔥",color:"#FF4444",
    desc:"Go fast, go often. Two stops, always on fresh rubber, always hunting the gap.",
    effects:"Pit stops: 2 · Lap pace +4% · Undercut attack +30% · Tyre degradation ignored · High DNF risk",
    mods:{pitStops:2,tyreBonus:0.96,undercutPenalty:1.3,overallPace:1.04,dnfRisk:0.06,scBonus:0.9},
    lapNotes:["Pushing hard on fresh rubber","The pace is there — question is whether the car survives","Attack, attack, attack"],
  },
  {
    id:"undercut_king","name":"Undercut Specialist",icon:"⚔️",color:"#E8002D",
    desc:"Always first to blink. Pit early, undercut the rival, use the fresh tyre delta to take the place.",
    effects:"Undercut efficiency +40% · Pit timing perfect · Overtaking on track −30% · Requires clean airspace post-stop",
    mods:{pitStops:2,tyreBonus:1.0,undercutPenalty:1.4,overallPace:1.01,dnfRisk:0.02,scBonus:1.15},
    lapNotes:["Box this lap — undercut window is open","Out on fresh tyres, they need to deliver now","The out-lap will define this entire race"],
  },
  {
    id:"overcut",     name:"Overcut Gamble",    icon:"♟️",color:"#BB66FF",
    desc:"Stay out longer than everyone else. Bank the track position, make rivals come to you.",
    effects:"Track position premium +20% · Later pitstop · Tyre pace degrades · Only works if traffic not an issue",
    mods:{pitStops:1,tyreBonus:0.92,undercutPenalty:0.6,overallPace:0.99,dnfRisk:0.01,scBonus:1.3},
    lapNotes:["Staying out — the overcut is the plan","Old tyres, but track position is priceless here","They need the safety car to make this work"],
  },
  {
    id:"fuel_save",   name:"Fuel Saving Mode",  icon:"💧",color:"#4488FF",
    desc:"Drop engine modes, save fuel, target a race-shaping deployment in the final stint.",
    effects:"Final 20 laps pace +6% · First 60% of race pace −3% · DNF risk −25% · Excellent for unpredictable races",
    mods:{pitStops:1,tyreBonus:1.05,undercutPenalty:0.8,overallPace:0.97,dnfRisk:-0.25,scBonus:1.1,lateBoost:1.06},
    lapNotes:["Saving fuel in the early phase","Targets are in the window — they'll deploy later","Patient race — the sting is in the tail"],
  },
  {
    id:"safety_car",  name:"Safety Car Hunter", icon:"🚗",color:"#FFC906",
    desc:"Build a big gap, pit early under green, let a safety car close it back up for free.",
    effects:"Pre-SC track position value +25% · Safety car timing bonus · Very high variance · Nothing happens without SC",
    mods:{pitStops:1,tyreBonus:1.1,undercutPenalty:0.5,overallPace:0.99,dnfRisk:-0.02,scBonus:1.5},
    lapNotes:["Waiting for the safety car window","Pitting very early — banking on a SC to close the gap","If the safety car doesn't come, this race is over"],
  },
  {
    id:"tyre_banker", name:"Tyre Banker",       icon:"🏦",color:"#FF8844",
    desc:"Qualify on softs, start race on used tyres, pit for a new set while rivals are struggling.",
    effects:"Stint 1 pace −5% · Stint 2 pace +8% (fresh vs degraded) · Qualifying tyre preserved · Complex to execute",
    mods:{pitStops:2,tyreBonus:1.08,undercutPenalty:1.2,overallPace:1.0,dnfRisk:0.01,scBonus:0.95},
    lapNotes:["Used tyres in the first stint by design","They're banking tyre life for later","The gap to fresher tyres will tell the real story"],
  },
  {
    id:"reactive",    name:"Reactive Strategy", icon:"🔄",color:"#00D2BE",
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

// ║  Rivals are stored per-driver as rivals:[] arrays. getRivalry() checks  ║
// ║  description string used in qualifying, sprint and race narratives.     ║
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
  {id:"norris",   name:"Lando Norris",    abbr:"NOR",num:4, teamId:"mclaren",    pace:94,consistency:90,wet:88,overtaking:91,defense:87,experience:82,mental:8, flag:"🇬🇧",goodTracks:["britain","belgium","usa"],       badTracks:["monaco","singapore","hungary"],style:"charger",rivals:["verstappen","leclerc"]},
  {id:"piastri",  name:"Oscar Piastri",   abbr:"PIA",num:81,teamId:"mclaren",    pace:91,consistency:88,wet:85,overtaking:87,defense:84,experience:76,mental:8, flag:"🇦🇺",goodTracks:["australia","japan","miami"],     badTracks:["monaco","canada","azerbaijan"],style:"technical",rivals:["norris","russell"]},
  {id:"russell",  name:"George Russell",  abbr:"RUS",num:63,teamId:"mercedes",   pace:90,consistency:89,wet:87,overtaking:85,defense:86,experience:78,mental:8, flag:"🇬🇧",goodTracks:["britain","belgium","brazil"],    badTracks:["monaco","azerbaijan","lasvegas"],style:"technical",rivals:["antonelli","norris"]},
  {id:"antonelli",name:"Kimi Antonelli",  abbr:"ANT",num:12,teamId:"mercedes",   pace:86,consistency:82,wet:80,overtaking:83,defense:79,experience:60,mental:6, flag:"🇮🇹",goodTracks:["italy","china","bahrain"],       badTracks:["monaco","singapore","canada"],style:"qualifier",rivals:["russell","hadjar"]},
  {id:"verstappen",name:"Max Verstappen", abbr:"VER",num:1, teamId:"redbull",    pace:97,consistency:95,wet:96,overtaking:96,defense:94,experience:92,mental:9, flag:"🇳🇱",goodTracks:["japan","belgium","brazil"],      badTracks:["singapore","monaco","hungary"],style:"aggressive",rivals:["norris","leclerc"]},
  {id:"hadjar",   name:"Isack Hadjar",    abbr:"HAD",num:6, teamId:"redbull",    pace:84,consistency:80,wet:78,overtaking:81,defense:78,experience:58,mental:6, flag:"🇫🇷",goodTracks:["bahrain","spain","austria"],     badTracks:["monaco","singapore","lasvegas"],style:"aggressive",rivals:["lawson","antonelli"]},
  {id:"leclerc",  name:"Charles Leclerc", abbr:"LEC",num:16,teamId:"ferrari",    pace:92,consistency:87,wet:88,overtaking:89,defense:86,experience:82,mental:7, flag:"🇲🇨",goodTracks:["monaco","azerbaijan","italy"],   badTracks:["hungary","brazil","japan"],style:"qualifier",rivals:["hamilton","verstappen"]},
  {id:"hamilton", name:"Lewis Hamilton",  abbr:"HAM",num:44,teamId:"ferrari",    pace:88,consistency:86,wet:90,overtaking:88,defense:88,experience:99,mental:9, flag:"🇬🇧",goodTracks:["britain","hungary","spain"],     badTracks:["azerbaijan","lasvegas","qatar"],style:"smooth",rivals:["leclerc","alonso"]},
  {id:"sainz",    name:"Carlos Sainz",    abbr:"SAI",num:55,teamId:"williams",   pace:87,consistency:88,wet:85,overtaking:84,defense:85,experience:86,mental:8, flag:"🇪🇸",goodTracks:["singapore","spain","australia"], badTracks:["hungary","brazil","abudhabi"],style:"smooth",rivals:["albon","leclerc"]},
  {id:"albon",    name:"Alex Albon",      abbr:"ALB",num:23,teamId:"williams",   pace:82,consistency:83,wet:80,overtaking:80,defense:82,experience:74,mental:7, flag:"🇹🇭",goodTracks:["miami","usa","australia"],       badTracks:["monaco","singapore","brazil"],style:"defender",rivals:["sainz"]},
  {id:"lawson",   name:"Liam Lawson",     abbr:"LAW",num:30,teamId:"racingbulls",pace:80,consistency:78,wet:77,overtaking:79,defense:76,experience:66,mental:7, flag:"🇳🇿",goodTracks:["japan","china","bahrain"],       badTracks:["monaco","singapore","austria"],style:"technical",rivals:["hadjar","lindblad"]},
  {id:"lindblad", name:"Arvid Lindblad",  abbr:"LIN",num:7, teamId:"racingbulls",pace:74,consistency:72,wet:70,overtaking:73,defense:70,experience:40,mental:5, flag:"🇬🇧",goodTracks:["britain","austria","bahrain"],   badTracks:["monaco","singapore","italy"],style:"qualifier",rivals:["lawson"]},
  {id:"alonso",   name:"Fernando Alonso", abbr:"ALO",num:14,teamId:"astonmartin",pace:88,consistency:90,wet:92,overtaking:89,defense:91,experience:99,mental:10,flag:"🇪🇸",goodTracks:["monaco","hungary","spain"],      badTracks:["azerbaijan","lasvegas","canada"],style:"strategist",rivals:["hamilton","verstappen"]},
  {id:"stroll",   name:"Lance Stroll",    abbr:"STR",num:18,teamId:"astonmartin",pace:72,consistency:70,wet:73,overtaking:68,defense:72,experience:72,mental:6, flag:"🇨🇦",goodTracks:["azerbaijan","bahrain","saudi"],  badTracks:["monaco","hungary","brazil"],style:"defender",rivals:["alonso"]},
  {id:"bearman",  name:"Oliver Bearman",  abbr:"BEA",num:87,teamId:"haas",       pace:78,consistency:76,wet:74,overtaking:76,defense:74,experience:58,mental:7, flag:"🇬🇧",goodTracks:["italy","britain","miami"],       badTracks:["monaco","singapore","japan"],style:"aggressive",rivals:["ocon"]},
  {id:"ocon",     name:"Esteban Ocon",    abbr:"OCO",num:31,teamId:"haas",       pace:79,consistency:77,wet:79,overtaking:76,defense:78,experience:78,mental:7, flag:"🇫🇷",goodTracks:["hungary","australia","spain"],   badTracks:["monaco","azerbaijan","lasvegas"],style:"ironman",rivals:["bearman","gasly"]},
  {id:"hulkenberg",name:"Nico Hülkenberg",abbr:"HUL",num:27,teamId:"audi",       pace:80,consistency:82,wet:78,overtaking:77,defense:80,experience:90,mental:8, flag:"🇩🇪",goodTracks:["austria","spain","brazil"],     badTracks:["monaco","singapore","italy"],style:"ironman",rivals:["bortoleto"]},
  {id:"bortoleto",name:"Gabriel Bortoleto",abbr:"BOR",num:5,teamId:"audi",       pace:76,consistency:74,wet:73,overtaking:75,defense:72,experience:52,mental:6, flag:"🇧🇷",goodTracks:["brazil","spain","usa"],         badTracks:["monaco","singapore","azerbaijan"],style:"charger",rivals:["hulkenberg"]},
  {id:"gasly",    name:"Pierre Gasly",    abbr:"GAS",num:10,teamId:"alpine",     pace:79,consistency:78,wet:77,overtaking:78,defense:77,experience:80,mental:7, flag:"🇫🇷",goodTracks:["italy","bahrain","spain"],       badTracks:["monaco","singapore","hungary"],style:"charger",rivals:["colapinto","ocon"]},
  {id:"colapinto",name:"Franco Colapinto",abbr:"COL",num:43,teamId:"alpine",     pace:76,consistency:74,wet:74,overtaking:75,defense:73,experience:55,mental:7, flag:"🇦🇷",goodTracks:["lasvegas","brazil","miami"],     badTracks:["monaco","singapore","japan"],style:"aggressive",rivals:["gasly"]},
  {id:"perez",    name:"Sergio Pérez",    abbr:"PER",num:11,teamId:"cadillac",   pace:78,consistency:77,wet:76,overtaking:76,defense:78,experience:88,mental:6, flag:"🇲🇽",goodTracks:["azerbaijan","saudi","singapore"],badTracks:["monaco","hungary","brazil"],style:"strategist",rivals:["bottas"]},
  {id:"bottas",   name:"Valtteri Bottas", abbr:"BOT",num:77,teamId:"cadillac",   pace:74,consistency:75,wet:74,overtaking:72,defense:74,experience:86,mental:7, flag:"🇫🇮",goodTracks:["austria","japan","spain"],       badTracks:["monaco","azerbaijan","lasvegas"],style:"ironman",rivals:["perez"]},
];

const TRACKS = [
  // id           name                     circuit                           flag  laps od  td  wr  type               sprint drs corners alt  temp abrasive pitDelta night lapLen topSpeed downforce street
  {id:"australia", name:"Australian GP",    circuit:"Albert Park",           flag:"🇦🇺",laps:58,od:45,td:60,wr:30,type:"mixed",         hasSprint:false,drs:4,corners:16,alt:10,  temp:21,abrasive:4,pitDelta:23,night:false,lapLen:5.28,topSpeed:318,downforce:6,street:false},
  {id:"china",     name:"Chinese GP",       circuit:"Shanghai Int'l",       flag:"🇨🇳",laps:56,od:40,td:65,wr:40,type:"mixed",         hasSprint:true, drs:2,corners:16,alt:5,   temp:16,abrasive:3,pitDelta:24,night:false,lapLen:5.45,topSpeed:327,downforce:6,street:false},
  {id:"japan",     name:"Japanese GP",      circuit:"Suzuka",                flag:"🇯🇵",laps:53,od:60,td:55,wr:50,type:"high-speed",    hasSprint:false,drs:2,corners:18,alt:40,  temp:15,abrasive:4,pitDelta:25,night:false,lapLen:5.81,topSpeed:330,downforce:7,street:false},
  {id:"bahrain",   name:"Bahrain GP",       circuit:"Bahrain Int'l",        flag:"🇧🇭",laps:57,od:40,td:68,wr:5, type:"technical",     hasSprint:false,drs:3,corners:15,alt:7,   temp:30,abrasive:7,pitDelta:22,night:true, lapLen:5.41,topSpeed:322,downforce:6,street:false},
  {id:"saudi",     name:"Saudi Arabian GP", circuit:"Jeddah Corniche",       flag:"🇸🇦",laps:50,od:30,td:58,wr:5, type:"street",        hasSprint:false,drs:3,corners:27,alt:10,  temp:28,abrasive:2,pitDelta:21,night:true, lapLen:6.17,topSpeed:340,downforce:5,street:true },
  {id:"miami",     name:"Miami GP",         circuit:"Miami Int'l Autodrome",flag:"🇺🇸",laps:57,od:50,td:70,wr:35,type:"street",        hasSprint:true, drs:3,corners:19,alt:2,   temp:28,abrasive:3,pitDelta:24,night:false,lapLen:5.41,topSpeed:320,downforce:6,street:true },
  {id:"spain",     name:"Spanish GP",       circuit:"Circuit de Barcelona",  flag:"🇪🇸",laps:66,od:55,td:72,wr:25,type:"high-downforce",hasSprint:false,drs:2,corners:16,alt:110, temp:24,abrasive:4,pitDelta:24,night:false,lapLen:4.66,topSpeed:315,downforce:8,street:false},
  {id:"monaco",    name:"Monaco GP",        circuit:"Circuit de Monaco",     flag:"🇲🇨",laps:78,od:88,td:40,wr:30,type:"street",        hasSprint:false,drs:1,corners:19,alt:15,  temp:20,abrasive:2,pitDelta:27,night:false,lapLen:3.34,topSpeed:290,downforce:8,street:true },
  {id:"canada",    name:"Canadian GP",      circuit:"Gilles Villeneuve",     flag:"🇨🇦",laps:70,od:25,td:68,wr:45,type:"street",        hasSprint:false,drs:2,corners:14,alt:12,  temp:22,abrasive:2,pitDelta:22,night:false,lapLen:4.36,topSpeed:330,downforce:5,street:true },
  {id:"madrid",    name:"Madrid GP",        circuit:"IFEMA Madrid",          flag:"🇪🇸",laps:55,od:45,td:65,wr:20,type:"street",        hasSprint:false,drs:3,corners:20,alt:665, temp:28,abrasive:3,pitDelta:23,night:false,lapLen:5.47,topSpeed:325,downforce:6,street:true },
  {id:"austria",   name:"Austrian GP",      circuit:"Red Bull Ring",         flag:"🇦🇹",laps:71,od:35,td:55,wr:40,type:"high-speed",    hasSprint:true, drs:3,corners:10,alt:680, temp:22,abrasive:3,pitDelta:21,night:false,lapLen:4.32,topSpeed:319,downforce:5,street:false},
  {id:"britain",   name:"British GP",       circuit:"Silverstone",           flag:"🇬🇧",laps:52,od:40,td:70,wr:60,type:"high-speed",    hasSprint:false,drs:2,corners:18,alt:126, temp:18,abrasive:4,pitDelta:23,night:false,lapLen:5.89,topSpeed:330,downforce:7,street:false},
  {id:"hungary",   name:"Hungarian GP",     circuit:"Hungaroring",           flag:"🇭🇺",laps:70,od:65,td:55,wr:40,type:"technical",     hasSprint:false,drs:2,corners:14,alt:260, temp:30,abrasive:3,pitDelta:23,night:false,lapLen:4.38,topSpeed:305,downforce:9,street:false},
  {id:"belgium",   name:"Belgian GP",       circuit:"Spa-Francorchamps",     flag:"🇧🇪",laps:44,od:30,td:60,wr:70,type:"high-speed",    hasSprint:false,drs:2,corners:19,alt:435, temp:17,abrasive:4,pitDelta:24,night:false,lapLen:7.00,topSpeed:340,downforce:5,street:false},
  {id:"netherlands",name:"Dutch GP",        circuit:"Zandvoort",             flag:"🇳🇱",laps:72,od:65,td:65,wr:45,type:"technical",     hasSprint:false,drs:2,corners:14,alt:5,   temp:18,abrasive:5,pitDelta:22,night:false,lapLen:4.26,topSpeed:320,downforce:8,street:false},
  {id:"italy",     name:"Italian GP",       circuit:"Monza",                 flag:"🇮🇹",laps:53,od:20,td:45,wr:30,type:"low-downforce", hasSprint:false,drs:2,corners:11,alt:162, temp:24,abrasive:3,pitDelta:23,night:false,lapLen:5.79,topSpeed:360,downforce:2,street:false},
  {id:"azerbaijan",name:"Azerbaijan GP",    circuit:"Baku City Circuit",     flag:"🇦🇿",laps:51,od:22,td:55,wr:15,type:"street",        hasSprint:false,drs:2,corners:20,alt:28,  temp:25,abrasive:2,pitDelta:21,night:false,lapLen:6.00,topSpeed:340,downforce:4,street:true },
  {id:"singapore", name:"Singapore GP",     circuit:"Marina Bay",            flag:"🇸🇬",laps:61,od:72,td:70,wr:50,type:"street",        hasSprint:false,drs:3,corners:23,alt:15,  temp:32,abrasive:3,pitDelta:27,night:true, lapLen:5.06,topSpeed:300,downforce:9,street:true },
  {id:"usa",       name:"United States GP", circuit:"Circuit of the Americas",flag:"🇺🇸",laps:56,od:40,td:65,wr:35,type:"mixed",        hasSprint:true, drs:2,corners:20,alt:300, temp:28,abrasive:5,pitDelta:24,night:false,lapLen:5.51,topSpeed:325,downforce:7,street:false},
  {id:"mexico",    name:"Mexican GP",       circuit:"Autodromo HR",          flag:"🇲🇽",laps:71,od:45,td:50,wr:25,type:"technical",     hasSprint:false,drs:3,corners:17,alt:2285,temp:21,abrasive:3,pitDelta:25,night:false,lapLen:4.30,topSpeed:365,downforce:4,street:false},
  {id:"brazil",    name:"Brazilian GP",     circuit:"Interlagos",            flag:"🇧🇷",laps:71,od:30,td:60,wr:65,type:"mixed",         hasSprint:true, drs:2,corners:15,alt:785, temp:26,abrasive:4,pitDelta:23,night:false,lapLen:4.31,topSpeed:328,downforce:5,street:false},
  {id:"lasvegas",  name:"Las Vegas GP",     circuit:"Las Vegas Strip",       flag:"🇺🇸",laps:50,od:35,td:55,wr:10,type:"street",        hasSprint:false,drs:3,corners:17,alt:640, temp:12,abrasive:2,pitDelta:22,night:true, lapLen:6.20,topSpeed:345,downforce:4,street:true },
  {id:"qatar",     name:"Qatar GP",         circuit:"Lusail Circuit",        flag:"🇶🇦",laps:57,od:45,td:75,wr:5, type:"technical",     hasSprint:true, drs:2,corners:16,alt:15,  temp:30,abrasive:8,pitDelta:24,night:true, lapLen:5.38,topSpeed:322,downforce:7,street:false},
  {id:"abudhabi",  name:"Abu Dhabi GP",     circuit:"Yas Marina",            flag:"🇦🇪",laps:58,od:45,td:50,wr:5, type:"mixed",         hasSprint:false,drs:2,corners:16,alt:3,   temp:28,abrasive:3,pitDelta:24,night:true, lapLen:5.28,topSpeed:332,downforce:6,street:false},
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
  {icon:"⚠️",type:"slowstop",label:"SLOW STOP",texts:["Tyre stuck on — {t}s lost!","Wheel gun issue — {t}s in the box!","Air gun failure — {t}s stationary!","Nut cross-threaded — {t}s lost!"]},
  {icon:"💥",type:"pitstop",label:"PIT NIGHTMARE",texts:["Lollipop error — released into traffic!","Wrong compound fitted — back to the box!","Unsafe release — five-second penalty incoming!","Front wing not secured — pit again next lap!"]},
  {icon:"⚠️",type:"strategy",label:"TYRE GAMBLE",texts:["Radical call — {cpd} tyres on? Bold.","Staying out on worn rubber — risky!","They're gambling on rain! Inters going on dry tyres.","Boxing early — going for the undercut on everyone!"]},
];
const EVT_C      = {incident:"#FF4444",dnf:"#FF6644",safetycar:"#FFC906",vsc:"#FFDD44",weather:"#4488FF",charge:"#44CC88",fastestlap:"#CC44FF",battle:"#FF8844",pitstop:"#44AAFF",slowstop:"#FF8800",drop:"#FF8844",start:"#E8002D",strategy:"#BB66FF",redflag:"#FF0000",damage:"#FF6600"};

const OFF_TRACK_MSGS = [
  "{d} runs wide through turn {t} — four wheels over the white line! Gravel scattered across the racing line.",
  "{d} locks up under braking and goes off at the chicane! Car bounces through the gravel trap.",
  "{d} loses the rear and spins — slides backwards into the gravel! Marshals on standby.",
  "{d} pushed wide by a rival and loses the car over the kerbs — gravel everywhere.",
  "{d} misjudges the entry and spears off into the gravel. Extraordinary save to keep it going.",
  "{d} half-pirouettes at the exit — tyres shredded by gravel, flat-spotted badly.",
];
const GRAVEL_MSGS = [
  "🪨 Gravel deposited at turn {t} from {d}'s excursion — VIRTUAL SAFETY CAR DEPLOYED.",
  "🪨 Debris and gravel scattered across the racing line — stewards request a VSC period.",
  "🪨 Gravel brought onto the circuit. Track limits compromised — VSC called immediately.",
  "🪨 Significant gravel on the apex of turn {t}. Marshals cannot clear without a VSC.",
];
const ENGINE_FAIL_MSGS = [
  "{d} has catastrophic ENGINE FAILURE — plume of white smoke from the rear! Car stops on track.",
  "{d} reports a sudden power loss — 'ENGINE, ENGINE!' on the radio. Car coasting to a halt.",
  "RETIREMENT: {d} — engine let go spectacularly on the main straight. Fire extinguisher deployed.",
  "{d} pulls over at turn {t} — 'I've lost all power.' Engine gone. Race over for {abbr}.",
];
const DAMAGE_MSGS = [
  "{d} pits with significant front wing damage — something picked up from a kerb strike.",
  "{d} reports a PUNCTURE! Limping back to the pits on a destroyed tyre.",
  "{d}'s floor badly damaged after riding a kerb. Handling described as 'undriveable' on the radio.",
  "{d} has lost a rear wing endplate — must pit immediately. Aero balance destroyed.",
  "{d} reports brake-by-wire failure. Pitting for investigation — race effectively over.",
  "{d} with massive floor damage — generating sparks on every straight. Pace destroyed.",
];

const pick  = a => a[Math.floor(Math.random()*a.length)];
const pickN = (a,n) => [...a].sort(()=>Math.random()-0.5).slice(0,n);
const Lf    = (t,f) => Math.max(1,Math.floor(t*f));

// ===================== SIMULATION ENGINE =====================


const _pick=(a)=>a[Math.floor(Math.random()*a.length)];

// ║  8 driver style archetypes, each applying stat modifiers to the         ║
// ║  race pace (overallPace), DNF risk, overtaking/defense weighting.       ║
// ║  Styles: Aggressive · Smooth · Qualifier · Defender · Charger           ║

// ===================== DRIVING STYLES =====================
const DRIVING_STYLES = [
  {
    id:"aggressive", name:"Aggressive", icon:"🔥", color:"#FF4444",
    desc:"Leaves nothing on the table — brilliant in wheel-to-wheel battles, hard on tyres and equipment.",
    effects:"Overtaking +6 · Pace +2 · Consistency −4 · Defence −4 · DNF risk +12%",
    mods:{pace:2,consistency:-4,overtaking:6,defense:-4,wet:-1,experience:0,dnfRisk:0.12,qualBonus:1,racePace:1},
  },
  {
    id:"smooth", name:"Smooth", icon:"🎯", color:"#44CC88",
    desc:"Never a wasted movement. Extracts the maximum from every set of tyres across a full race distance.",
    effects:"Consistency +6 · Wet +4 · Pace −2 · DNF risk −15%",
    mods:{pace:-2,consistency:6,overtaking:-2,defense:2,wet:4,experience:0,dnfRisk:-0.15,qualBonus:-1,racePace:2},
  },
  {
    id:"qualifier", name:"Qualifier", icon:"⚡", color:"#FFC906",
    desc:"Electrifying over a single flying lap. Asks serious questions of the tyres in a race.",
    effects:"Quali pace +5 · Race consistency −4 · Experience effect −2",
    mods:{pace:0,consistency:-4,overtaking:1,defense:0,wet:-1,experience:-2,dnfRisk:0.04,qualBonus:5,racePace:-3},
  },
  {
    id:"defender", name:"Defender", icon:"🛡️", color:"#4488FF",
    desc:"Makes every overtake feel like climbing a wall. Clinical at managing gaps and holding positions.",
    effects:"Defence +8 · Consistency +3 · Overtaking −6 · Pace −2",
    mods:{pace:-2,consistency:3,overtaking:-6,defense:8,wet:1,experience:2,dnfRisk:-0.08,qualBonus:-2,racePace:0},
  },
  {
    id:"charger", name:"Charger", icon:"🚀", color:"#FF8844",
    desc:"Comes alive in traffic. Finds gaps others don't see and thrives starting from the back.",
    effects:"Overtaking +8 · Pace +3 (from low grid) · Consistency −3 · Defence −3",
    mods:{pace:1,consistency:-3,overtaking:8,defense:-3,wet:1,experience:0,dnfRisk:0.06,qualBonus:-2,racePace:2},
  },
  {
    id:"strategist", name:"Strategist", icon:"♟️", color:"#BB66FF",
    desc:"Reads the race like a data feed. Timing is everything — under-cuts, safety cars, tyre windows.",
    effects:"Experience +5 · Consistency +4 · Undercut bonus · Pace −1",
    mods:{pace:-1,consistency:4,overtaking:0,defense:2,wet:2,experience:5,dnfRisk:-0.1,qualBonus:-1,racePace:1},
  },
  {
    id:"technical", name:"Technical", icon:"🔬", color:"#00D2BE",
    desc:"At home in the corners. Precision over raw pace — thrives at high-downforce and technical circuits.",
    effects:"Wet +6 · Consistency +3 · Tech circuit +4 · High-speed −2",
    mods:{pace:-1,consistency:3,overtaking:0,defense:1,wet:6,experience:2,dnfRisk:-0.05,qualBonus:0,racePace:1},
  },
  {
    id:"ironman", name:"Ironman", icon:"⚙️", color:"#B6BABD",
    desc:"Still circulating on lap 70 when others have retired. The metronome. Points finisher extraordinaire.",
    effects:"Consistency +7 · DNF risk −30% · Pace −3 · Overtaking −3",
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

// Reference lap time (seconds) used as the baseline to split into sectors.
function refLapSeconds(track) {
  return QUAL_REFS[track.id] || (track.lapLen||5)*18.5;
}
// A race's fastest lap runs a touch slower than a qualifying pole lap (fuel load, tyre wear).
function estimateRaceLapSeconds(track) {
  return refLapSeconds(track)*1.015;
}

// A driver+car's raw affinity for a given sector — cornering ability and
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
// exactly back to lapSeconds — car/driver sector strength only redistributes
// time between sectors relative to the rest of the field, it never changes
// the total (so finishing order and points are untouched by this feature).
function computeSectorTimes(entry, fieldEntries, track, lapSeconds) {
  const sectors = getTrackSectors(track);
  const raw = sectors.map(s=>sectorEdgeRaw(entry.driver, entry.team, s));
  const fieldAvg = sectors.map((s,i)=>{
    const vals = fieldEntries.map(e=>sectorEdgeRaw(e.driver, e.team, s));
    return vals.reduce((a,b)=>a+b,0)/vals.length;
  });
  const K = 0.0065; // stat-point edge → seconds
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

// ║  calcBase()      — Deterministic base score from driver+team+track.     ║
// ║  calcQualBase()  — calcBase + qualifying style bonus.                   ║
// ║                    traffic, rivalries, mechanical issues, strategy).     ║
// ║  runSprint()     — Abbreviated race (~100km). Sprint points for top 8.  ║
// ║                    DNFs, weather, fastest lap, position battles.        ║
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
    const cause=_pick(["clips the barrier with the front wing","locks up and goes wide over the kerbs","moments of snap oversteer into the wall","loses the rear exiting the corner and spins","a fraction too early on the power — the car snaps sideways"]);
    const consequence=_pick([
      `Multiple laps deleted — ${Math.ceil(Math.random()*4)} drivers in the pit lane caught with timing issues.`,
      `${_pick(sorted.slice(6,16)).driver.name} had a stunning lap going — the yellow flag extinguished it completely.`,
      `Crews scramble on the pitwall — everyone recalculating their final run timing.`,
      `Teams with drivers on hot laps furious on the radio. The timing could not have been worse.`,
    ]);
    evts.push({type:"yellow",icon:"🟡",driver:yfDriver.driver.name,
      text:`⚠️ YELLOW FLAG — ${yfDriver.driver.name} (${yfDriver.team.name}) ${cause} at ${corner}. ${consequence}`});
    if(track.street&&Math.random()<0.3) {
      evts.push({type:"yellow",icon:"🔴",text:`RED FLAG! The barriers need repairs after that incident. ${_pick(["Six minutes","Eight minutes","Five minutes"])} lost — the session clock will be extended. Teams scramble tyre allocations.`});
    }
  }

  // Mechanical / reliability
  if(mechDriver) {
    const issue=_pick(["hydraulics pressure warning","gearbox issue","brake-by-wire failure","water temperature spike","DRS mechanism stuck","front wing damage from a kerb strike","MGU-K deployment problem"]);
    const consequence=_pick([
      `${mechDriver.driver.name} pits for investigation. Engineers stare at laptops. The session is most likely over for them.`,
      `The ${mechDriver.team.name} garage erupts in activity — this is a critical issue at the worst possible time.`,
      `${mechDriver.driver.name} manages to return to the pit lane but the damage is already done. Time lost, rhythm broken.`,
      `Mechanics work under frantic conditions — if they fix it in time, ${mechDriver.driver.name} gets one lap. Just one.`,
    ]);
    evts.push({type:"mechanical",icon:"🔧",driver:mechDriver.driver.name,
      text:`🔧 ${mechDriver.driver.name} (${mechDriver.team.name}) reports a ${issue} over the radio. ${consequence}`});
  }

  // Rivalry / team-mate battle
  if(rivalry&&session==="Q3") {
    evts.push({type:"rivalry",icon:"⚔️",
      text:`The paddock is watching ${rivalry.desc} play out in real time. Both drivers delivered near-identical sector times on their first runs — ${_pick(["the gap is tenths","thousandths separate them","the data shows almost zero difference in technique through the medium-speed corners","this could come down to tyre temperature on the final flying lap"])}.`});
  }
  if(battlePair&&battlePair[0]&&battlePair[1]&&battlePair[0].driver.id!==battlePair[1].driver.id) {
    const rv=getRivalry(battlePair[0].driver,battlePair[1].driver);
    if(rv&&Math.random()<0.6) {
      evts.push({type:"rivalry",icon:"⚔️",
        text:`${rv.desc.charAt(0).toUpperCase()+rv.desc.slice(1)} is the subplot nobody can ignore. ${battlePair[0].driver.name} went ${_pick(["two","three","four","five"])} thousandths quicker through the final sector — ${battlePair[1].driver.name} will have seen that number and responded on the next run.`});
    }
  }

  // Session-specific events
  if(session==="Q1") {
    // Traffic chaos
    if(Math.random()<0.45) {
      const victim=_pick(sorted.slice(8,18));
      const blocker=_pick(sorted.filter(e=>e.driver.id!==victim.driver.id));
      evts.push({type:"traffic",icon:"🚦",driver:victim.driver.name,
        text:`Traffic incident: ${victim.driver.name} finds ${blocker.driver.name} on a slow out-lap right through ${_pick(SECTORS)}. The lap is ruined — ${_pick(["the timing shows they lost nearly four tenths","the radio exchange is not suitable for broadcast","${victim.driver.name} slams a fist on the steering wheel","a lap that could have been safe is now a question mark"])}.`});
    }
    // Track evolution story
    if(Math.random()<0.65) {
      evts.push({type:"info",icon:"📈",
        text:`Track evolution is the story of ${session} — lap times are ${_pick(["0."+Math.floor(Math.random()*5+2)+"s","almost half a second","nearly four tenths"])} faster now than in the opening minutes as rubber builds on the racing line. Teams that ran last have a significant advantage, and the order will look very different by the end.`});
    }
    // Impede incident
    if(track.street&&Math.random()<0.5) {
      const d1=_pick(sorted.slice(0,8)), d2=_pick(sorted.slice(8,16));
      evts.push({type:"incident",icon:"🚧",
        text:`INCIDENT reported: ${d1.driver.name} and ${d2.driver.name} arrive at the same part of ${track.circuit} at the same time — both on flying laps. Stewards are investigating. Could result in a grid penalty before the race even begins.`});
    }
    // Lap time surprise
    if(Math.random()<0.4) {
      const darkHorse=_pick(sorted.slice(Math.floor(sorted.length*0.35),Math.floor(sorted.length*0.6)));
      evts.push({type:"surprise",icon:"⭐",driver:darkHorse.driver.name,team:darkHorse.team.name,
        text:`${darkHorse.driver.name} has been quietly rapid all session — ${darkHorse.team.name} running a different front wing spec this weekend has been the subject of paddock whispers. Whatever they've done, ${_pick(["it's working","the lap time suggests it is","it has closed the gap to the front significantly"])}.`});
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
      evts.push({type:"strategy",icon:"♟️",driver:gambler.driver.name,team:gambler.team.name,
        text:`STRATEGY CALL: ${gambler.team.name} send ${gambler.driver.name} out on ${compound} — preserving fresh rubber for the race start. ${stakes}`});
    }
    // Elimination knife-edge
    if(bubbleZone.length>=2) {
      const [a,b,c]=bubbleZone;
      const pA=sorted.indexOf(a)+1;
      const pB=sorted.indexOf(b)+1;
      const gap=((a.score-b.score)*0.011).toFixed(3);
      evts.push({type:"battle",icon:"⏱️",
        text:`THE CUT LINE: ${a.driver.name} (P${pA}) and ${b.driver.name} (P${pB}) — ${gap}s between them and the difference between Q3 and the garage. ${_pick([
          `Both teams have sent their drivers out for final runs. The tension in the pit wall is unbearable.`,
          `${c?c.driver.name+" is breathing down their necks from P"+(sorted.indexOf(c)+1)+" — three drivers, two spots.":" This is the last chance."}`,
          `Radio traffic is frantic. Engineers shouting sector times. Drivers giving everything.`,
          `This is exactly the kind of story that defines a season — points, momentum, confidence, all hanging on a single sector.`,
        ])}`});
    }
    // Team-mate tension
    if(Math.random()<0.35) {
      const team=_pick(sorted.map(e=>e.team).filter((t,i,a)=>a.findIndex(x=>x.id===t.id)===i));
      const teammates=sorted.filter(e=>e.team.id===team.id).slice(0,2);
      if(teammates.length===2) {
        const [t1,t2]=teammates;
        evts.push({type:"rivalry",icon:"🤝",
          text:`Inside the ${team.name} garage, ${t1.driver.name} has gone ${_pick(["two","three","four"])} tenths clear of ${t2.driver.name}. Team radio to the slower car: ${_pick([
            '"You need to find more in sector two."',
            '"We need that lap. Car is capable of it."',
            '"Box after this lap — different wing setting."',
            '"We\'re adjusting the balance — give us one more lap."',
          ])} The tension is real.`});
      }
    }
  }

  if(session==="Q3") {
    // Banker lap strategy
    if(fast) {
      const risk=Math.random()<0.5;
      evts.push({type:"banker",icon:"💜",driver:fast.driver.name,
        text:`${fast.driver.name} sets their first run banker time: ${_pick(["clinical","composed","beautifully executed"])} lap that puts them ${_pick(["clearly","marginally","comfortably"])} at the top. Now the question: ${risk?"come back out on a second set of softs and try to improve — risking a yellow flag deleting the time":"bank what they have and watch the rivals struggle to beat it"}?`});
    }
    // Multiple improvement attempts
    if(second&&Math.random()<0.65) {
      evts.push({type:"final",icon:"🏁",driver:second.driver.name,
        text:`${second.driver.name}'s final run: purple in sector one, ${_pick(["green in sector two — this is a lap!","yellow in the final chicane — they've lost it","matching ${fast.driver.name} through the middle","marginal gains everywhere but nothing decisive"])}. The team on the pitwall are leaning forward, headphones on, every hundredth counting.`});
    }
    // Impede on final lap
    if(Math.random()<0.4) {
      const victim=_pick(sorted.slice(1,6));
      const blocker=_pick(sorted.filter(e=>e.driver.id!==victim.driver.id).slice(0,9));
      evts.push({type:"incident",icon:"⚠️",driver:victim.driver.name,
        text:`${victim.driver.name} BLOCKED — ${blocker.driver.name} on an out-lap right through ${_pick(SECTORS)} on the final flying laps. ${_pick([
          "Stewards have noted the incident.",
          "Radio message: 'That cost me at LEAST two tenths.' The damage is done.",
          "Both teams summoned to the stewards post-session.",
          "The gap to pole is now a tenth bigger than it needed to be.",
        ])}`});
    }
    // Lap time improvement
    if(Math.random()<0.5) {
      const improver=_pick(sorted.slice(2,7));
      evts.push({type:"improvement",icon:"📉",driver:improver.driver.name,
        text:`${improver.driver.name} IMPROVES! ${_pick([
          "Purple in all three sectors — this is a special lap!",
          "Gains two tenths in sector three alone — the final corner the key difference.",
          "Smoothest lap of the session, every corner linked beautifully.",
          "Sets a personal best through the high-speed section — the car looks planted.",
        ])} The timing screens flash. The order changes.`});
    }
    // Rival data breach moment
    if(rivalry&&Math.random()<0.5) {
      evts.push({type:"rivalry",icon:"📡",
        text:`Inside the garages of ${sorted[0].team.name} and ${sorted[1].team.name} — both teams watching the same timing data, adapting in real time. The engineers know every sector time, every micro-sector. ${_pick([
          "This is modern F1 at its most precise — and its most psychological.",
          "The margins are so small that setup philosophy, not raw pace, separates them.",
          "Every tenth gained in the data warehouse the night before is visible here.",
          "The performance gap between these two teams is now measured in hundredths.",
        ])}`});
    }
  }

  // Night-race atmosphere
  if(track.night&&Math.random()<0.6) {
    evts.push({type:"info",icon:"🌙",
      text:`Under the floodlights at ${track.circuit}, grip levels behave differently — the asphalt has cooled significantly since FP2, changing tyre compound performance windows. ${_pick([
        "Several drivers reporting the car feels 'planted' in sectors they found difficult in daylight.",
        "The thermal cameras are working overtime — rear tyre temperatures are the critical variable.",
        "Teams running more front wing to compensate for the lower-grip conditions at night.",
        "The shadows at the apexes remain a psychological challenge — you can't always see where you're turning in.",
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

  // Q1: All 20 drivers. High chaos — different tyre strategies, banker laps, traffic.
  const q1Form = makeSessionForm(6);
  const q1 = drivers.map(d=>{
    const team=teams.find(t=>t.id===d.teamId)||teams[teams.length-1];
    const s=sessionScore(d, team, 5, 0, 3.5, q1Form);
    return {driver:d, team, score:s, q1Score:s};
  }).sort((a,b)=>b.score-a.score).map((e,i)=>({...e, q1Pos:i+1, elim1:i>=15}));
  const q1Events = genQEvents("Q1", q1, track, 15);

  // Q2: Top 15 only. Fresh session form — car balance can shift significantly.
  const q2Form = makeSessionForm(5);
  const q2base = q1.filter(e=>!e.elim1).map(e=>{
    const s=sessionScore(e.driver, e.team, 4, 1.2, 3, q2Form);
    return {...e, score:s, q2Score:s};
  }).sort((a,b)=>b.score-a.score).map((e,i)=>({...e, q2Pos:i+1, elim2:i>=10}));
  const q2Events = genQEvents("Q2", q2base, track, 10);

  // Q3: Top 10 only. Full-attack flying lap. Fresh form draw — pole shootout can produce surprises.
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
  const streetCtx = track.street ? "the barriers demand respect — no flying lap is risk-free in FP" : "the engineers will be studying tyre life carefully on this surface";
  return [
    _pick([
      `${label} — ${track.circuit.toUpperCase()}\n\n${fastest.driver.name} sets the pace in ${label} for ${topTeam.name}. ${gap}s covers the top two — but read nothing into it. Fuel loads, tyre compounds and aero configurations vary wildly between teams in practice.`,
      `FREE PRACTICE ${sessionNum} · ${track.name.toUpperCase()}\n\n${fastest.driver.name} (${topTeam.name}) topped the ${label} timesheet at ${track.circuit}. Practice times are notoriously misleading — teams run different fuel quantities and programmes — but the ${topTeam.name} looked genuinely quick on every compound.`,
    ]),
    _pick([
      `${second?.driver.name||"P2"} was ${gap}s back in second, though ${streetCtx}. The top ten is tightly packed — a tenth or two separates several cars through the midfield.`,
      `The ${sessionNum===1?"track is still green — grip will improve significantly as rubber goes down over the weekend":"race simulation runs completed this afternoon give teams their first real picture of tyre degradation at race pace. Strategists will be poring over every data point tonight"}.`,
    ]),
    surprise ? `${surprise.driver.name} looked particularly at home here — this is a circuit that suits their driving style, and the ${label} data will encourage the ${surprise.team.name} garage going into the rest of the weekend.` :
    _pick([
      `${sessionNum===1?"Teams will now assess the data and decide tyre allocations for the rest of the weekend.":"With practice complete, attention turns to qualifying. The short-run pace was clearer in FP2 — expect the competitive order to resemble this more closely come Q1."}`,
      `${positions[4]?.driver.name||"The midfield"} impressed in ${label} — an unexpected name in the top five that will have the data analysts at the other teams raising eyebrows.`,
    ]),
  ];
}

// Sprint qualifying: SQ1/SQ2/SQ3 — shorter sessions, same knockout structure as Q1/Q2/Q3.
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
      `${session} — ${track.circuit.toUpperCase()} | SPRINT QUALIFYING\n\n${fastest.driver.name} (${fastest.team.name}) sets the pace in ${session} with ${gap}s over ${second?.driver.name||"P2"}. The ${sessionDesc} — shorter, sharper, less margin for error than standard qualifying.`,
      `SPRINT QUALIFYING ${session} · ${track.name.toUpperCase()}\n\n${fastest.driver.name} leads ${session} for ${fastest.team.name}. ${gap}s covers P1 and P2 — in sprint qualifying every tenth matters because there are no second chances.`,
    ]),
    session==="SQ3"
      ? _pick([
          `${fastest.driver.name} takes sprint pole. From the front ${fastest.driver.name} controls the sprint race — ${second?.driver.name||"P2"} lines up alongside and will be watching for the opening.`,
          `Sprint pole belongs to ${fastest.driver.name}. The ${fastest.team.name} driver delivered a clean lap in SQ3. ${second?.driver.name||"P2"} starts alongside — expect a battle to the first braking zone.`,
        ])
      : dropped.length
        ? `${session} eliminations: ${dropped.map(e=>e.driver.name).join(", ")} — knocked out with sprint qualifying complete for them.`
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

// ── buildQuarterStandings ─────────────────────────────────────────────────
// Takes the final sorted positions array and produces 4 quarter snapshots.
// quarterWeather: array of {wet,sc} per quarter so wet conditions increase
// swap chaos and widen gaps (rain causes unpredictability).
function buildQuarterStandings(finalPositions, totalLaps, quarterWeather) {
  var qw = quarterWeather || [{wet:false,sc:false},{wet:false,sc:false},{wet:false,sc:false},{wet:false,sc:false}];
  var baseSwap  = [7, 4, 2, 0];
  var gapScales = [[0.3,2.2],[0.8,4.5],[1.5,7.0],[null,null]];

  // Deduplicate by driver id and cap at 22 — prevents any upstream duplication showing in standings
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

    // Q4 = exact final positions — DNFs already sorted to the back, one entry per driver
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

  // ── Red Flag ─────────────────────────────────────────────────────────────
  // Higher probability on street circuits and wet conditions
  const rfBaseProb = track.type==="street" ? 0.28 : 0.14;
  const rfProb = isWet ? rfBaseProb + 0.18 : rfBaseProb;
  const hasRF = Math.random() < rfProb;
  // Red flag lap: avoid first 3 laps and last 5 laps (must leave racing time)
  const rfLap = hasRF ? Math.max(4, Lf(TL,0.12)+Math.floor(Math.random()*Lf(TL,0.65))) : 0;
  // Suspension duration in laps: 3–8 laps off track
  const rfDuration = hasRF ? 3+Math.floor(Math.random()*6) : 0;
  const rfResumeLap = hasRF ? Math.min(rfLap+rfDuration, TL-3) : 0;
  // Red flag cause
  const RF_CAUSES = isWet
    ? ["massive aquaplaning incident — car in the barriers","flooding on the racing line — race suspended","multi-car pile-up in the wet","driver airlifted from cockpit — precautionary red flag"]
    : ["enormous crash at turn 1 — debris everywhere","fire in the pit lane — race suspended","car stranded in dangerous position","medical intervention required on track — red flag shown"];
  const rfCause = hasRF ? pick(RF_CAUSES) : "";
  // After red flag: teams get free tyre change — all cars line up pit-lane order
  // This means on restart the order is set at rfLap positions (slight shuffle)
  const rfRestartMessages = [
    "STANDING START restart! Grid reformed on the pit straight.",
    "ROLLING START for the resumption — safety car leads the field.",
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
  const stratContrast=poleStrat?.id!==p2Strat?.id?` ${pole.team.name} on ${poleStrat?.name||"standard"} strategy, ${grid[1]?.team?.name||"P2"} favouring ${p2Strat?.name||"different approach"} — a fascinating strategic duel awaits.`:"";
  events.push({lap:1,type:"start",icon:"🚦",text:`LIGHTS OUT! ${pole.driver.name} nails the launch from pole. ${badS.driver.name} loses ground immediately.${stratContrast}`});
  const fl1a=pick(grid.slice(3,11)),fl1b=pick(grid.slice(3,11).filter(e=>e!==fl1a));
  if(fl1b) events.push({lap:1,type:"incident",icon:"⚠️",text:`LAP 1: ${fl1a.driver.name} and ${fl1b.driver.name} touch through the first complex — both continue.`});
  entries.filter(e=>e.fl1).forEach(e=>events.push({lap:1,type:"incident",icon:"💥",text:`FIRST LAP CHAOS! ${e.driver.name} is OUT!`}));
  if(isWet){
    events.push({lap:1,type:"weather",icon:"🌧️",text:`RAIN at ${track.circuit}! Conditions treacherous — wets mandatory. Car control critical.`});
    // Wet-specific early incidents — higher chance of spins and lock-ups
    if(Math.random()<0.65){
      const spinD=pick(grid.slice(2,15));
      events.push({lap:Lf(TL,0.06),type:"incident",icon:"💦",text:`Lap ${Lf(TL,0.06)}: ${spinD.driver.name} SPINS on the wet tarmac! Narrowly avoids the wall.`});
    }
    if(Math.random()<0.50){
      const lockD=pick(grid.slice(3,18));
      events.push({lap:Lf(TL,0.10),type:"incident",icon:"🌊",text:`Lap ${Lf(TL,0.10)}: ${lockD.driver.name} aquaplanes through turn 3 — massive moment! Car saved.`});
    }
    if(dryingLap>0){
      events.push({lap:dryingLap,type:"weather",icon:"🌤️",text:`Lap ${dryingLap}: Track beginning to dry. Teams agonising over the switch to intermediates — timing is everything.`});
      events.push({lap:dryingLap+3,type:"weather",icon:"☀️",text:`Lap ${dryingLap+3}: Racing line drying fast. Slicks vs inters battle begins — wrong call here loses the race.`});
    }
  }
  if(hasSC2){
    events.push({lap:sc2Lap,type:"safetycar",icon:"🚗",text:`SECOND SAFETY CAR lap ${sc2Lap}!${isWet?" Visibility near zero — dangerous conditions.":"Another incident brings the SC back out."} Gaps erased again.`});
    events.push({lap:sc2End,type:"safetycar",icon:"🟢",text:`Green flag lap ${sc2End}! SC withdraws — ${isWet?"soaking wet track,":""}expect fireworks at the restart.`});
  }
  [[0,4,Lf(TL,0.09),"the lead"],[4,8,Lf(TL,0.14),"the points"],[8,13,Lf(TL,0.19),"upper midfield"],[13,18,Lf(TL,0.23),"lower midfield"],[18,22,Lf(TL,0.27),"the back"]].forEach(([a,b,lap,lbl])=>{
    const grp=final.slice(a,b).filter(e=>!e.dnf);
    if(grp.length<2) return;
    const [x,y]=pickN(grp,2);
    if(x&&y) events.push({lap,type:"battle",icon:"🔥",text:`Lap ${lap}: ${x.driver.name} and ${y.driver.name} nose-to-tail in ${lbl}.`});
  });
  // ── Penalty & event-DNF trackers (fed by events, applied after gap calc) ──
  const timePenalties={};  // driverId -> seconds
  const eventDNFs={};      // driverId -> {lap, reason}
  const addPenalty=(driver,secs)=>{ timePenalties[driver.id]=(timePenalties[driver.id]||0)+secs; };
  const addEventDNF=(driver,lap,reason)=>{ if(!eventDNFs[driver.id]) eventDNFs[driver.id]={lap,reason}; };

  // ── Pit stop helper: normal, slow, or disaster (wet-aware, penalty-aware) ──
  const pitEvent=(e,lap,stopNum)=>{
    const strat=getTeamStrategy(e.team);
    const wetPitCpd=isWet?pick(["Intermediates","Wets","Intermediates"]):null;
    const cpd=wetPitCpd||pick(CPDS);
    const r=Math.random();
    const disasterThresh=isWet?0.14:0.10;
    const slowThresh    =isWet?0.36:0.28;
    const gambleThresh  =isWet?0.44:0.38;
    if(r<disasterThresh){
      // Pit disaster — pick specific type with matching penalty
      const dtype=Math.floor(Math.random()*4);
      if(dtype===0){
        // Unsafe release into traffic → 5s penalty
        addPenalty(e.driver,5);
        const wetSuffix=isWet?" Pitlane soaking wet — driver nearly loses it.":"";
        return {lap,type:"pitstop",icon:"🚨",text:`LAP ${lap}: ${e.driver.name} (${e.team.name}) — UNSAFE RELEASE into traffic!${wetSuffix} 5-SECOND TIME PENALTY ISSUED.`};
      } else if(dtype===1){
        // Wrong compound → 10s stop-and-go equivalent
        addPenalty(e.driver,10);
        return {lap,type:"pitstop",icon:"🚨",text:`LAP ${lap}: ${e.driver.name} (${e.team.name}) — Wrong compound fitted! Back to the box — 10-SECOND TIME PENALTY applied.`};
      } else if(dtype===2){
        // Front wing not secured → 5s penalty + slow stop
        addPenalty(e.driver,5);
        return {lap,type:"slowstop",icon:"🚨",text:`LAP ${lap}: ${e.driver.name} — Front wing not secured! Pits again next lap. 5-SECOND TIME PENALTY.`};
      } else {
        // Lollipop / jack error → 5s penalty
        addPenalty(e.driver,5);
        const wetSuffix=isWet?" Chaos in the wet pit lane.":"";
        return {lap,type:"pitstop",icon:"🚨",text:`LAP ${lap}: ${e.driver.name} (${e.team.name}) — Lollipop error!${wetSuffix} Released too early — 5-SECOND TIME PENALTY.`};
      }
    } else if(r<slowThresh){
      const secs=(isWet?5.5+Math.random()*5:4+Math.random()*6).toFixed(1);
      const txt=pick(PIT_DISASTERS[0].texts).replace("{t}",secs);
      return {lap,type:"slowstop",icon:"⚠️",text:`LAP ${lap}: ${e.driver.name} pits — ${txt}${isWet?" Cold tyres in the wet — treacherous.":" "} Exits on ${cpd}.`};
    } else if(r<gambleThresh){
      const wetGamble=isWet?_pick(["SLICKS in the wet?! Enormous gamble!","Going to slicks as rain intensifies — bold move!","Staying on slicks — they're committing to the drying line."]):"";
      const d=PIT_DISASTERS[2];
      const txt=wetGamble||pick(d.texts).replace("{cpd}",cpd);
      return {lap,type:"strategy",icon:"♟️",text:`LAP ${lap}: ${e.driver.name} (${e.team.name}) — ${txt}`};
    } else {
      const stratNote=strat?_pick(strat.lapNotes||["Executing team strategy"]):"";
      const pitTime=(isWet?2.5+Math.random()*1.2:2.0+Math.random()*0.9).toFixed(1);
      const stopLabel=stopNum===1?"First stop":stopNum===2?"Second stop":"Final stop";
      const wetNote=isWet?" 🌧️ "+_pick(["Intermediates the call.","Wets still on.","Going to inters.","Brave call for slicks."]):"";
      return {lap,type:"pitstop",icon:"🔄",text:`LAP ${lap}: ${e.driver.name} (${e.team.name}) pits — ${cpd} fitted in ${pitTime}s. ${stopLabel}.${wetNote} ${stratNote||""}`};
    }
  };

  const p1b=Lf(TL,0.25);
  pickN(finishers.slice(0,Math.min(12,finishers.length)),6).forEach((e,i)=>{
    events.push(pitEvent(e,p1b+i*2,1));
  });
  if(finishers.length>=4){
    const[u1,u2]=finishers.slice(1,5);
    if(u1&&u2) events.push({lap:p1b+4,type:"strategy",icon:"♟️",text:`LAP ${p1b+4}: ${u1.driver.name} attempts the undercut on ${u2.driver.name} — will it work?`});
  }
  [[0,1],[2,3],[5,6],[8,9],[11,12],[14,15],[17,18]].forEach(([a,b],idx)=>{
    if(!finishers[a]||!finishers[b]) return;
    const lap=Lf(TL,0.38)+idx*Math.floor(TL*0.025);
    events.push({lap,type:"battle",icon:"🔥",text:`Lap ${lap}: ${finishers[a].driver.name} vs ${finishers[b].driver.name} — DRS! Side by side!`});
  });
  if(hasSC){
    events.push({lap:scLap,type:"safetycar",icon:"🚗",text:`SAFETY CAR lap ${scLap}! Field bunches. Strategy chaos across the pitlane.`});
    const scF=finishers.length>3?pick(finishers.slice(3,Math.min(10,finishers.length))):null;
    if(scF) events.push(pitEvent(scF,scLap+1,2));
    events.push({lap:scEnd,type:"safetycar",icon:"🟢",text:`Green flag lap ${scEnd}! Safety car in — gaps erased, racing resumes.`});
  }
  // ── Red Flag sequence ────────────────────────────────────────────────────
  if(hasRF){
    // Suspension announcement
    events.push({lap:rfLap,type:"redflag",icon:"🔴",text:`🔴 RED FLAG! LAP ${rfLap}/${TL} — ${rfCause}. RACE SUSPENDED.`});
    // Drivers are told to slow and return to pit lane
    events.push({lap:rfLap,type:"redflag",icon:"🔴",text:`All cars return to the pit lane. Officials assessing the situation. Race clock stopped.`});
    // Free tyre/wing changes while race is suspended
    const rfPitDrivers=pickN(finishers.slice(0,Math.min(15,finishers.length)),Math.min(8,finishers.length));
    rfPitDrivers.forEach(function(e){
      const cpd=isWet?pick(["Intermediates","Wets","Slicks"]):pick(CPDS);
      const wingNote=Math.random()<0.25?" Front wing replaced.":"";
      events.push({lap:rfLap+1,type:"pitstop",icon:"🔄",text:`RED FLAG PIT: ${e.driver.name} (${e.team.name}) fits ${cpd} — free stop under suspension.${wingNote}`});
    });
    // Track inspection / delay
    const delayMins=5+Math.floor(Math.random()*20);
    events.push({lap:rfLap+Math.floor(rfDuration*0.4),type:"redflag",icon:"🔴",text:`Track inspection underway. ${delayMins}-minute delay anticipated. Marshals clearing the incident.`});
    // Medical / recovery note (wet races more serious)
    if(isWet&&Math.random()<0.5){
      events.push({lap:rfLap+Math.floor(rfDuration*0.5),type:"redflag",icon:"🚑",text:`Medical car on track. Driver receiving attention. Race director in communication with both teams.`});
    }
    // Race director decision — resume or declare result at last lap completed
    const resumeDecision=rfResumeLap<TL-2;
    if(resumeDecision){
      events.push({lap:rfResumeLap-1,type:"redflag",icon:"🟢",text:`RACE DIRECTOR: Racing will resume from LAP ${rfResumeLap}. ${pick(rfRestartMessages)}`});
      // Restart overtakes
      const restartP=pick(finishers.slice(1,Math.min(6,finishers.length)));
      const restartVic=finishers[0];
      if(restartP&&restartVic&&Math.random()<0.45){
        events.push({lap:rfResumeLap,type:"battle",icon:"⚡",text:`RESTART LAP ${rfResumeLap}: ${restartP.driver.name} OVERTAKES ${restartVic.driver.name} off the line! New LEADER!`});
      } else {
        events.push({lap:rfResumeLap,type:"start",icon:"🚦",text:`RESTART LAP ${rfResumeLap}: ${restartVic.driver.name} leads into turn 1. Frantic racing resumes — ${TL-rfResumeLap} laps remaining.`});
      }
      // Restart incidents common — some cause DNF, some cause time penalty
      if(Math.random()<0.40){
        const incD=pick(finishers.slice(3,Math.min(14,finishers.length)));
        if(incD){
          const crashR=Math.random();
          if(crashR<0.30){
            // Serious crash → DNF
            addEventDNF(incD.driver,rfResumeLap,"restart collision");
            events.push({lap:rfResumeLap,type:"dnf",icon:"💥",text:`RESTART LAP ${rfResumeLap}: ${incD.driver.name} INTO THE BARRIER! Massive crash — CAR DESTROYED. DNF.`});
          } else if(crashR<0.60){
            // Contact → 5s penalty
            const incD2=pick(finishers.slice(1,10).filter(x=>x!==incD));
            addPenalty(incD.driver,5);
            events.push({lap:rfResumeLap,type:"incident",icon:"⚠️",text:`Lap ${rfResumeLap}: ${incD.driver.name} makes contact with ${incD2?incD2.driver.name:"P2"} under braking — 5-SECOND TIME PENALTY for causing a collision.`});
          } else {
            // Close call — no penalty
            events.push({lap:rfResumeLap,type:"incident",icon:"⚠️",text:`Lap ${rfResumeLap}: ${incD.driver.name} locked up at the restart — both cars continue, stewards investigating.`});
          }
        }
      }
    } else {
      events.push({lap:rfLap+1,type:"redflag",icon:"🔴",text:`RACE DECLARED. Results taken at the end of lap ${rfLap-1}. Insufficient laps remaining to restart.`});
    }
  }
  // Only fire generic RETIREMENT events for DNFs not already covered by an event-DNF message
  entries.filter(e=>e.dnf&&!e.fl1&&e.dnfLap>1&&!eventDNFs[e.driver.id]).forEach(e=>events.push({lap:e.dnfLap,type:"dnf",icon:"🔧",text:`LAP ${e.dnfLap}: RETIREMENT — ${e.driver.name} (${e.team.name}) — ${pick(FAIL)}.`}));
  const p2b=Lf(TL,0.55);
  pickN(finishers.slice(0,Math.min(12,finishers.length)),6).forEach((e,i)=>{
    events.push(pitEvent(e,p2b+i*2,2));
  });
  final.forEach((e,fi)=>{
    const ch=(e.gridPos-1)-fi;
    if(!e.dnf&&Math.abs(ch)>=5) events.push({lap:Lf(TL,0.5)+Math.floor(Math.random()*Lf(TL,0.2)),type:ch>0?"charge":"drop",icon:ch>0?"⚡":"📉",text:ch>0?`${e.driver.name} flying — ${ch} places gained from grid!`:`${e.driver.name} drops ${Math.abs(ch)} — tyres gone.`});
  });
  if(finishers.length>=3){
    const gS=(((final[1]?.gap||5)*0.35)).toFixed(1);
    events.push({lap:TL-Math.floor(Math.random()*5)-4,type:"battle",icon:"🏁",text:`Late in the race: ${finishers[1].driver.name} closing on ${finishers[0].driver.name} — gap ${gS}s!`});
  }
  if(finishers[9]&&finishers[10]) events.push({lap:TL-3,type:"battle",icon:"🔥",text:`LAP ${TL-3}: ${finishers[9].driver.name} vs ${finishers[10].driver.name} — final points position!`});
  const flD=finishers.length>0?pick(finishers.slice(0,Math.min(8,finishers.length))):null;
  let fastestLapSeconds=null, fastestLapSectors=null;
  if(flD){
    const flL=Lf(TL,0.78)+Math.floor(Math.random()*Lf(TL,0.12));
    events.push({lap:flL,type:"fastestlap",icon:"💜",text:`FASTEST LAP: ${flD.driver.name} goes purple on lap ${flL}!`});
    fastestLapSeconds=estimateRaceLapSeconds(track);
    fastestLapSectors=computeSectorTimes(flD, finishers, track, fastestLapSeconds);
  }
  if(finishers.length>=20){
    const[bk1,bk2]=finishers.slice(-4);
    if(bk1&&bk2) events.push({lap:Lf(TL,0.65),type:"battle",icon:"🔥",text:`Lap ${Lf(TL,0.65)}: ${bk1.driver.name} and ${bk2.driver.name} — their own battle at the back.`});
  }

  // ── Mid-race incidents: off-track, gravel, crashes, engine failures, damage ─
  const _turn=()=>Math.floor(Math.random()*16)+1;
  const _fmt=(s,d)=>s.replace(/{d}/g,d.driver.name).replace(/{t}/g,_turn()).replace(/{abbr}/g,d.team.abbr||d.team.name);

  // Off-track excursions (1–3 per race, more in wet)
  const offTrackCount=isWet?Math.floor(Math.random()*3)+1:Math.floor(Math.random()*2)+(Math.random()<0.55?1:0);
  for(let oi=0;oi<offTrackCount;oi++){
    const offD=pick(entries.filter(e=>!e.dnf||e.dnfLap>Lf(TL,0.15)));
    if(!offD) continue;
    const offLap=Lf(TL,0.08)+Math.floor(Math.random()*Lf(TL,0.78));
    const offMsg=_fmt(pick(OFF_TRACK_MSGS),offD);
    events.push({lap:offLap,type:"incident",icon:"🪨",text:`Lap ${offLap}: ${offMsg}`});
    // Gravel deposited — 70% chance of VSC (higher in wet/street), 15% chance of full SC
    const gravelR=Math.random();
    const scThresh=isWet||track.type==="street"?0.22:0.15;
    const vscThresh=isWet?0.90:0.70;
    if(gravelR<scThresh){
      const gscEnd=offLap+Math.floor(Math.random()*3)+2;
      events.push({lap:offLap,type:"safetycar",icon:"🚗",text:`SAFETY CAR deployed — lap ${offLap}. ${_fmt(pick(GRAVEL_MSGS),offD).replace("VIRTUAL SAFETY CAR DEPLOYED","gravel on the racing line")} Marshals need time to clear.`});
      events.push({lap:gscEnd,type:"safetycar",icon:"🟢",text:`Green flag lap ${gscEnd}! Gravel cleared — racing resumes.`});
    } else if(gravelR<vscThresh){
      const vscEnd=offLap+Math.floor(Math.random()*2)+1;
      events.push({lap:offLap,type:"vsc",icon:"🟡",text:`VIRTUAL SAFETY CAR — lap ${offLap}. ${_fmt(pick(GRAVEL_MSGS),offD)} Clears lap ${vscEnd}.`});
      events.push({lap:vscEnd,type:"vsc",icon:"🟢",text:`VSC ENDING — lap ${vscEnd}. Track clear. Gaps frozen during the VSC period.`});
    }
  }

  // Crashes (0–3 in wet, 0–2 dry; more on street circuits)
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
      // DNF crash — big impact → SC
      addEventDNF(crashD.driver,crashLap,isWet?"aquaplaned into barrier":"barrier impact");
      const scEndC=crashLap+Math.floor(Math.random()*4)+2;
      events.push({lap:crashLap,type:"dnf",icon:"💥",text:`LAP ${crashLap}: CRASH! ${crashD.driver.name} (${crashD.team.name}) HITS THE BARRIER${isWet?" — aquaplaning in the wet":""}! Car is destroyed. DNF.`});
      events.push({lap:crashLap,type:"safetycar",icon:"🚗",text:`SAFETY CAR — lap ${crashLap}. Wreckage to clear after the ${crashD.driver.name} incident. Gaps erased.`});
      events.push({lap:scEndC,type:"safetycar",icon:"🟢",text:`Green flag lap ${scEndC}! Debris cleared. Pack sprints into turn 1 — fireworks expected.`});
    } else if(crashR<0.75){
      // Significant contact → 5s penalty + VSC or SC
      const secondD=pick(entries.filter(e=>e!==crashD&&!e.dnf));
      addPenalty(crashD.driver,5);
      const scEndC=crashLap+Math.floor(Math.random()*3)+1;
      const deployType=Math.random()<0.5?"safetycar":"vsc";
      events.push({lap:crashLap,type:"incident",icon:"💥",text:`LAP ${crashLap}: COLLISION — ${crashD.driver.name} into ${secondD?secondD.driver.name:"the wall"}! Both continue. Stewards investigating.`});
      events.push({lap:crashLap,type:deployType,icon:deployType==="safetycar"?"🚗":"🟡",text:`${deployType==="safetycar"?"SAFETY CAR":"VIRTUAL SAFETY CAR"} — lap ${crashLap}. Debris from the contact. 5-SECOND TIME PENALTY for ${crashD.driver.name}.`});
      events.push({lap:scEndC,type:deployType,icon:"🟢",text:`${deployType==="safetycar"?"Green flag":"VSC ending"} lap ${scEndC}. Racing resumes.`});
    } else {
      // Close call — minor VSC or nothing
      const secondD=pick(entries.filter(e=>e!==crashD&&!e.dnf));
      events.push({lap:crashLap,type:"incident",icon:"⚠️",text:`LAP ${crashLap}: ${crashD.driver.name} and ${secondD?secondD.driver.name:"a backmarker"} make contact — both carry on. Damage possible.`});
      if(Math.random()<0.40){
        const vscEndC=crashLap+1;
        events.push({lap:crashLap,type:"vsc",icon:"🟡",text:`VIRTUAL SAFETY CAR — lap ${crashLap}. Carbon fibre on the racing line from the ${crashD.driver.name} incident.`});
        events.push({lap:vscEndC,type:"vsc",icon:"🟢",text:`VSC ENDING — lap ${vscEndC}. Track clear.`});
      }
    }
  }

  // Engine failures (0–2 per race based on reliability)
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
    events.push({lap:failLap,type:"dnf",icon:"🔧",text:`LAP ${failLap}: ${msg}`});
    // Engine fires / spectacular failures may need VSC
    if(Math.random()<0.45){
      const vscEndE=failLap+1;
      events.push({lap:failLap,type:"vsc",icon:"🟡",text:`VIRTUAL SAFETY CAR — lap ${failLap}. ${failD.driver.name}'s stricken car to be recovered from the track.`});
      events.push({lap:vscEndE,type:"vsc",icon:"🟢",text:`VSC ENDING — lap ${vscEndE}. Car recovered. Racing resumes at full speed.`});
    }
  }

  // Car damage (mid-race): 0–2 incidents affecting pace (not always a DNF)
  const numDamage=Math.random()<(isWet?0.55:0.35)?(Math.random()<0.30?2:1):0;
  for(let di=0;di<numDamage;di++){
    const dmgPool=entries.filter(e=>!e.dnf&&!eventDNFs[e.driver.id]);
    if(dmgPool.length===0) continue;
    const dmgD=pick(dmgPool);
    const dmgLap=Lf(TL,0.15)+Math.floor(Math.random()*Lf(TL,0.65));
    const dmgMsg=_fmt(pick(DAMAGE_MSGS),dmgD);
    const dmgSeverity=Math.random();
    if(dmgSeverity<0.30){
      // Serious — DNF (can't continue)
      addEventDNF(dmgD.driver,dmgLap,pick(["suspension failure","puncture — barrier impact","brake failure"]));
      events.push({lap:dmgLap,type:"damage",icon:"💥",text:`LAP ${dmgLap}: ${dmgMsg} TERMINAL — car cannot continue. DNF for ${dmgD.driver.name}.`});
      if(Math.random()<0.35){
        const vscEndD=dmgLap+1;
        events.push({lap:dmgLap,type:"vsc",icon:"🟡",text:`VIRTUAL SAFETY CAR — lap ${dmgLap}. Debris from ${dmgD.driver.name}'s car on the circuit.`});
        events.push({lap:vscEndD,type:"vsc",icon:"🟢",text:`VSC ENDING — lap ${vscEndD}. Track clear.`});
      }
    } else {
      // Survivable — driver continues but pace is hurt (reflected in commentary)
      events.push({lap:dmgLap,type:"damage",icon:"🔧",text:`LAP ${dmgLap}: ${dmgMsg} Racing on but losing time every lap.`});
    }
  }

  // ── Apply event-driven DNFs ───────────────────────────────────────────────
  // Apply event-DNFs — mark any driver (finisher or pre-existing DNF) with event reason
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

  // ── Compute gaps (finishers only) ─────────────────────────────────────────
  cleanFinishers.forEach(function(e,i){
    if(i===0){e.gap=0;return;}
    const diff=(cleanFinishers[0].pace-e.pace)*0.55;
    const prev=cleanFinishers[i-1].gap||0;
    const gap=Math.max(prev+Math.random()*2.2,diff>0?diff:prev+0.5);
    e.gap=parseFloat(gap.toFixed(3));
  });
  cleanDNFs.forEach(function(e){e.gap=null;});

  // ── Apply time penalties and re-sort finishers by effective time ──────────
  cleanFinishers.forEach(function(e){
    const pen=timePenalties[e.driver.id]||0;
    if(pen>0){
      e.timePenalty=pen;
      e.gap=parseFloat(((e.gap||0)+pen).toFixed(3));
    }
  });
  cleanFinishers.sort(function(a,b){return (a.gap||0)-(b.gap||0);});

  // Rebuild final — one entry per driver, finishers then DNFs
  final.length=0;
  cleanFinishers.forEach(function(e){final.push(e);});
  cleanDNFs.forEach(function(e){final.push(e);});

  final.forEach((e,i)=>{
    e.finalPos=i+1;
    e.points=(!e.dnf&&i<10)?PTS[i]:0;
    if(flD&&e.driver.id===flD.driver.id&&!e.dnf&&i<10) e.points+=1;
  });

  events.sort((a,b)=>a.lap-b.lap);

  // ── Quarter standings: shuffle final order by decreasing amounts each quarter ──
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

// ── Leaderboard PNG export ──────────────────────────────────────────────────
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
      const gapTxt=i===0?(opts.leaderLabel||"LEADER"):(gap!==null?"+"+gap+"s":"—");
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

// ── Weekend CSV/Excel export ────────────────────────────────────────────────
function exportWeekendCSV(track,sessions){
  const BOM='﻿';
  const esc=s=>{const v=String(s??"");return(v.includes(",")||v.includes('"')||v.includes("\n"))?'"'+v.replace(/"/g,'""')+'"':v;};
  const row=arr=>arr.map(esc).join(",");
  const rows=[];
  rows.push(row(["F1 SIM — "+track.name,track.circuit,"","","",""]));
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
      if(e.dnf) g="DNF Lap "+(e.dnfLap||"?")+(e.dnfReason?" — "+e.dnfReason:"");
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
    addPos("GRAND PRIX — FINAL CLASSIFICATION",race.positions,null,true);
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

// ── Testing CSV/Excel export ────────────────────────────────────────────────
function exportTestingCSV(testResults,testSession){
  const BOM='﻿';
  const esc=s=>{const v=String(s??"");return(v.includes(",")||v.includes('"'))?'"'+v.replace(/"/g,'""')+'"':v;};
  const row=arr=>arr.map(esc).join(",");
  const rows=[];
  rows.push(row(["F1 SIM — "+testSession.name,testSession.dates||""]));
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
    rows.push(row(["=== DAY "+day.day+" — "+day.conditions.label+" ==="]));
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
        CLICK TO TOGGLE: 🟢 GOOD TRACK (+5 PTS) · 🔴 BAD TRACK (−5 PTS) · MAX 3 EACH
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
      <div style={{fontSize:12,color:"#899",marginTop:5}}>🟢 {goodTracks.length}/3 favourites · 🔴 {badTracks.length}/3 tough circuits</div>
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
        Select up to 3 rivals — they trigger special commentary moments in qualifying, sprints and races.
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
                <span style={{fontSize:10,opacity:0.7}}>×</span>
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
        <div style={{fontSize:11,color:"#555",marginTop:5}}>No rivals set — this driver has no special narrative triggers.</div>
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
        <button onClick={onBack} style={{background:"#2A2A30",color:"#ccc",border:"none",padding:"7px 14px",cursor:"pointer",fontFamily:"inherit",fontSize:13,fontWeight:700,borderRadius:3}}>← BACK</button>
        <div>
          <div style={{fontSize:20,fontWeight:700}}>{r.trackFlag} {r.trackName} — Round {r.round}</div>
          <div style={{fontSize:12,color:"#778",marginTop:2}}>{r.trackCircuit||""} {r.hasSprint?"· ⚡ Sprint Weekend":""} · Read-only snapshot</div>
        </div>
      </div>
      {/* Sub-tabs */}
      <div style={{display:"flex",gap:3,marginBottom:14,background:"#0D0D10",padding:4,borderRadius:4,border:"1px solid #1E1E22"}}>
        {[["race","🏁 RACE"],wkndTabs.length>0?["qual","📋 WEEKEND"]:null,snap.sprint?["sprint","⚡ SPRINT"]:null].filter(Boolean).map(([k,l])=>(
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
              {snap.race.isWet&&<span style={{background:"#4488FF18",color:"#4488FF",fontSize:11,fontWeight:700,padding:"2px 7px",borderRadius:2}}>🌧️ WET</span>}
              {snap.race.hasSC&&<span style={{background:"#FFC90618",color:"#FFC906",fontSize:11,fontWeight:700,padding:"2px 7px",borderRadius:2}}>🚗 SC LAP {snap.race.scLap}</span>}
              {snap.race.fastestLapName&&<span style={{background:"#CC44FF18",color:"#CC44FF",fontSize:11,fontWeight:700,padding:"2px 7px",borderRadius:2}}>💜 FL: {snap.race.fastestLapName}</span>}
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
                          :<><div style={{fontSize:12,fontFamily:"monospace",color:i===0?"#FFC906":"#bbb"}}>{i===0?"🏁 WIN":`+${e.gap}s`}</div>{e.points>0&&<div style={{fontSize:11,color:"#E8002D",fontWeight:700}}>+{e.points}pts</div>}</>}
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
          {snap.qual?.runsUsed>1&&<div style={{fontSize:12,color:"#E8002D",marginBottom:8}}>⟳ Averaged over ×{snap.qual.runsUsed} runs</div>}
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
          <div style={{fontSize:11,color:"#FFC906",letterSpacing:2,marginBottom:8,fontWeight:700}}>⚡ SPRINT — {snap.sprint.sprintLaps} LAPS</div>
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
          <button onClick={onClose} style={{background:"none",border:"none",color:"#aaa",cursor:"pointer",fontSize:26}}>×</button>
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
                  <div style={{fontSize:11,color:sty.color,fontWeight:700,marginBottom:3}}>{sty.icon} {sty.name} — Style Profile</div>
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
              <div style={{fontSize:11,color:"#E8002D",fontWeight:700,letterSpacing:1.5,marginBottom:8}}>⚔️ RIVALRIES</div>
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
            {key:"carPace",     label:"CAR PACE",       min:55, max:99,  color:"#E8002D", desc:"Raw car performance — affects qualifying and race pace"},
            {key:"reliability", label:"RELIABILITY",    min:55, max:99,  color:"#44CC88", desc:"Mechanical reliability — lower = higher DNF risk"},
            {key:"pitSpeed",    label:"PIT SPEED",      min:70, max:99,  color:"#FFC906", desc:"Pit stop execution speed — affects undercut/overcut"},
            {key:"tyreLife",    label:"TYRE LIFE",      min:40, max:90,  color:"#4488FF", desc:"Tyre management — how long tyres last at race pace"},
            {key:"cornering",   label:"CORNERING",      min:1,  max:20,  color:"#BB66FF", desc:"Corner speed advantage — benefits technical circuits"},
            {key:"topSpeed",    label:"TOP SPEED",      min:1,  max:20,  color:"#FF8844", desc:"Straight-line speed — benefits power circuits with DRS"},
          ];
          return(
            <div style={{marginBottom:14,padding:"12px 14px",background:"#111115",borderRadius:5,border:"1px solid #1E1E22"}}>
              <div style={{fontSize:11,color:"#4488FF",fontWeight:700,letterSpacing:1.5,marginBottom:14}}>🏎 CAR PERFORMANCE</div>
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
                <div style={{display:"flex",gap:10,marginTop:3}}>
                  {e.sectors.map((s,si)=>(
                    <span key={si} style={{fontSize:11,fontFamily:"monospace",fontWeight:700,color:e.sectorPurple&&e.sectorPurple[si]?"#CC44FF":"#667"}}>
                      S{si+1} {s.toFixed(3)}
                    </span>
                  ))}
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

// Aggregated qualifying: run N times, average grid positions → canonical grid

// ║  When ACCURACY selector is set to ×5/×10/×20, these functions run the  ║
// ║  random variance. The canonical result is the most probable outcome.    ║
// ║  aggQual()   — Average qualifying grid from N runs                      ║
// ║  aggSprint() — Average sprint positions from N runs                     ║
// Aggregated qualifying: run N times, average scores → canonical grid.
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
  // falls through all three sets — append them at the back sorted by q1Score
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

// Aggregated race: run N times, average finish positions → canonical race
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
  // Use repRace positions as canonical — already has correct DNFs, penalties, gaps
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

// Aggregated sprint: run N times, average positions → canonical sprint
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


// ║  Runs the full weekend pipeline (qual + optional sprint + race) N times ║
// ║  average position, total points. Powers the 📊 MULTI-SIM tab.          ║
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
  {id:"barcelona_test", name:"Barcelona Pre-Season Test", circuit:"Circuit de Catalunya", flag:"🇪🇸", dates:"Feb 10–12, 2027", trackId:"spain",  days:3},
  {id:"bahrain_test",   name:"Bahrain Pre-Season Test",  circuit:"Bahrain Int'l Circuit", flag:"🇧🇭", dates:"Feb 24–26, 2027", trackId:"bahrain", days:3},
];


// ║  Generates per-day test data: qualifying simulation laps, long-run      ║
// ║  character (installation / setup / quali sims) with conditions.         ║
function runPreseasonTest(days, drivers, teams, trackId) {
  const track = TRACKS.find(t=>t.id===trackId)||TRACKS[0];
  const ISSUE_TYPES = ["Hydraulics issue","Power unit concern","Gearbox problem","Brake failure","Cooling issue","Suspension damage","Oil leak","Electrical fault","DRS fault","Floor damage"];
  const CONDITIONS = [
    {label:"Clear & cool",icon:"🌤️", gripMod:0,   paceMod:0},
    {label:"Overcast",    icon:"☁️",  gripMod:0.1, paceMod:0.1},
    {label:"Light rain",  icon:"🌦️", gripMod:0.3, paceMod:0.5},
    {label:"Windy",       icon:"💨",  gripMod:0.2, paceMod:0.2},
    {label:"Sunny & hot", icon:"☀️",  gripMod:-0.1,paceMod:-0.1},
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
      // Each day slightly different pace picture — teams try different configs
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

      // Per-day issues — more common on day 1
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

  // Build overall summary — best lap from any day, total laps
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


// ║  Sky Sports-style written reports for each session. All randomised      ║
// ║                                                                          ║
// ║  buildSprintCaption()     — Sprint race report with rivalries            ║
// ║  buildDayCaption()        — Per-day test report                          ║
// ║  buildQ2Caption()         — Q2 session narrative with tyre strategy      ║
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
  const altNote=track.alt>1500?` — the thin air at ${track.alt}m altitude flattered the high-downforce setups`:"";
  const tempNote=track.temp>30?` in brutal ${track.temp}°C heat`:(track.temp<12?` in surprisingly cold ${track.temp}°C conditions`:"");

  // --- Sky Sports style intro ---
  const intros=[
    `QUALIFYING REPORT — ${track.name.toUpperCase()} ${nightStr?'| NIGHT SESSION':''}\n\n${pole.driver.name} has taken a superb pole position at ${streetStr}${tempNote}, delivering a lap that will live long in the memory. The ${pole.team.name} driver banked it at exactly the right moment${altNote}.`,
    `${track.flag} QUALIFYING RESULT — ${track.circuit}\n\n${pole.driver.name} is on pole position for tomorrow's ${track.name}. The ${pole.team.name} driver produced a ${_pick(["scintillating","stunning","finely-crafted"])} lap in Q3${nightStr?" under the floodlights":""} to claim top spot${altNote}${tempNote}.`,
    `IT'S ${pole.driver.name.toUpperCase()} ON POLE AT ${track.circuit.toUpperCase()}!\n\nA ${_pick(["masterclass","statement of intent","brilliant"])} qualifying performance from the ${pole.team.name} driver sealed the top spot. ${poleGap}s was the margin over ${p2.driver.name} — in Formula 1 terms, a ${tight?"razor-thin":dominant?"significant":"clear"} advantage${tempNote}.`,
  ];

  // --- Front row / top 3 detail ---
  const frontRows=[
    sameTeam
      ?`${p2.driver.name} completes a stunning ${pole.team.name} 1-2, locking out the entire front row. That is a commanding statement from the ${pole.team.name} garage going into tomorrow.`
      :`${p2.driver.name} lines up alongside on the front row for ${p2.team.name}. The two front-row starters come from different teams, meaning strategy will be the decisive battleground tomorrow. ${p3?`${p3.driver.name} (${p3.team.name}) completes the top three.`:""}`,
    `The front row belongs to ${pole.driver.name} and ${p2.driver.name}, ${p2.team.id===pole.team.id?"both flying the flag for "+pole.team.name:"representing "+pole.team.name+" and "+p2.team.name+" respectively"}. ${p3?`P3 goes to ${p3.driver.name} — ${p3.team.name} will fancy their chances of a podium from that grid slot.`:""}`,
  ];

  // --- Margin analysis ---
  const marginAnalysis=tight
    ?[`This was a breathtakingly close Q3. The top ${Math.min(q3.length,6)} drivers were covered by less than a second — a gap that can evaporate entirely under a safety car deployment. Any of the top four could realistically win this race.`,
      `Tenths and thousandths decided pole. The data will make fascinating reading back at the factories tonight — both teams operating at the absolute ragged edge of their development.`]
    :dominant
    ?[`${pole.driver.name} was simply untouchable. That gap to ${p2.driver.name} is not just a pole position — it's a message. ${pole.team.name} arrive at ${track.circuit} with a significant performance advantage, and the rest of the grid will be scrambling to find a strategic answer.`,
      `Dominant. Commanding. Complete. ${pole.driver.name} put in a lap that answered every question about the ${pole.team.name}'s form at this circuit. Unless something dramatic happens at the start, they will be very hard to beat tomorrow.`]
    :[`${poleGap}s is the gap at the front — enough to feel the pressure, not so much that the race is decided. ${p2.driver.name} will be watching for an opportunity at the start and studying ${pole.driver.name}'s lines through the first complex.`,
      `${pole.driver.name} holds the advantage, but ${p2.driver.name} will have studied every data point from this session. The duel continues tomorrow, and starting on the clean side of the grid could be decisive.`];

  // --- Drama and challenges ---
  const drama=[];

  // Q2 shock exits
  if(bigElim) drama.push(`The session's most dramatic moment came in Q2: ${bigElim.driver.name} — who had looked quick all weekend — was eliminated in fifteenth place. The ${bigElim.team.name} team had gambled on track position and the rubber simply wasn't there. Championship implications may follow.`);
  if(bigQ1Elim) drama.push(`A hammer blow for ${bigQ1Elim.team.name}: ${bigQ1Elim.driver.name} failed to advance from Q1, eliminated in a session they had been expected to clear comfortably. Questions will be asked about setup direction after a difficult Friday.`);

  // Surprise top-three
  if(surprise) drama.push(`The surprise of qualifying: ${surprise.driver.name} delivers a career-defining lap to slot into the top three. Starting from P${surprise.q3Pos||3} with the big teams watching, this could be a landmark moment for ${surprise.team.name} at this circuit.`);

  // Track-specific challenges
  if(track.night) drama.push(`The floodlights at ${track.circuit} create a unique challenge — shadows over the apexes, changing grip levels as the track surface cools, and the psychological pressure of racing at night. Several drivers reported visibility issues through the high-speed sweepers.`);
  if(track.street) drama.push(`Around the ${track.circuit} street circuit, the walls are unforgiving and millimetres matter. ${_pick([p3,p4])?.driver.name||p2.driver.name} was caught out by a yellow flag on their final flying lap — robbed of what could have been a front row start.`);
  if(track.wr>45) drama.push(`Rain forecasts hung over the session all day, forcing teams into a high-stakes gamble: bank a time early, or wait for more rubber and risk the deluge. The weather held, but the tension in the pit lane was palpable from the first moment of Q1.`);
  if((track.alt||0)>1200) drama.push(`At ${track.alt}m above sea level, the thin air at ${track.circuit} fundamentally changes how the cars behave — less downforce, longer braking zones, and engines running in a very narrow performance window. Teams who nailed the setup philosophy tonight will have a meaningful strategic advantage.`);
  if((track.abrasive||0)>=7) drama.push(`The notoriously abrasive surface here demands a conservative tyre management strategy. Several teams were seen running harder compounds than expected in Q2 — protecting rubber for a longer first stint tomorrow rather than chasing lap time tonight.`);
  if(track.corners&&track.corners>20) drama.push(`With ${track.corners} corners in a single lap, qualifying at ${track.circuit} is a test of absolute precision. Any lock-up, any missed apex, any moment of hesitation — and the lap is gone. The survivors of Q3 produced textbook performances under enormous pressure.`);

  // Failure scenarios / what can go wrong tomorrow
  const risks=[
    `WHAT COULD GO WRONG TOMORROW: ${pole.driver.name} leads from pole, but a slow getaway into Turn 1 remains the primary threat — ${track.street?"the street circuit walls leave no room for recovery from a poor start":track.corners>15?"the complex first sector punishes overly defensive driving":"first corner positioning will be crucial"}. Weather${track.wr>25?" remains a genuine factor":""} and safety car probability at this circuit is historically high.`,
    `KEY RISKS FOR TOMORROW: The race pace data told a different story to qualifying. ${p2.driver.name}'s long runs were not noticeably slower than ${pole.driver.name}'s — suggesting that if tyre degradation sets in, the lead could change hands. A virtual safety car or a poorly timed stop could overturn the entire qualifying order.`,
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
    `⚡ SPRINT RACE — ${track.circuit.toUpperCase()} | ${spLaps} LAPS | ${_pick(["FULL ATTACK","NO MARGIN FOR ERROR","EVERY LAP COUNTS"])}\n\n${winner.driver.name} takes the sprint victory for ${winner.team.name}. ${spLaps} laps, no safety car buffer, no tyre conservation mindset — just eight points for the win and a pecking order established before the main event. ${winner.driver.name} ${_pick([
      "controlled the race from the front with ruthless efficiency.",
      "survived an aggressive first lap to build a lead that was never seriously threatened.",
      "managed tyre life and pace brilliantly — the benchmark for tomorrow's strategy discussions.",
      "converted a perfect start into a lights-to-flag victory — the team could not have scripted it better.",
    ])}`,
    `${winner.driver.name.toUpperCase()} WINS THE SPRINT — ${track.name.toUpperCase()}\n\n${spLaps} laps of intensity and it is ${winner.driver.name} who pockets eight points. The sprint format offers no hiding places, no strategic options — raw pace and racing intelligence decide the outcome, and ${winner.driver.name} had both. ${p2?.driver.name||"P2"} pushed hard in the final laps but ${_pick(["could never find a way through","the gap was just too large to close","the DRS didn't deliver the attack needed","the tyre delta told the wrong story"])}.`,
    `SPRINT RESULT: ${winner.driver.name} · ${p2?.driver.name||"P2"} · ${p3?.driver.name||"P3"}\n\nPoints scored: ${pts8}\n\n${winner.driver.name} builds their sprint-weekend record with another maximum haul. The ${winner.team.name} garage celebrates, but the real debrief starts immediately — tomorrow is what the points champions are built from.`,
  ];

  const drama=[];

  // Chaotic start
  if(Math.random()<0.55) {
    const chaosDriver=_pick(pos.slice(0,8));
    drama.push(`LAP 1 CHAOS: ${_pick([
      `${chaosDriver.driver.name} gets an incredible getaway from P${chaosDriver.gridPos} and slots into the top five before the first corner.`,
      `Contact at Turn 1 — ${chaosDriver.driver.name} (${chaosDriver.team.name}) gets squeezed to the outside and loses three positions in an instant. The sprint is effectively over for them.`,
      `Drama at the start: ${chaosDriver.driver.name} and ${_pick(pos.filter(e=>e.driver.id!==chaosDriver.driver.id).slice(0,6)).driver.name} wheel-to-wheel from the lights — ${_pick(["neither gives an inch","${chaosDriver.driver.name} backs out at the last moment","they touch — both cars continue but there is damage"])}. The sprint is on.`,
    ])}`);
  }

  // Charger story
  if(chargers.length>0) {
    const c=chargers[0];
    const finalPos=pos.findIndex(e=>e.driver.id===c.driver.id)+1;
    drama.push(`THE DRIVE: ${c.driver.name} was the story inside the story. Starting P${c.gridPos}, the ${c.team.name} driver ${_pick([
      `carved through traffic with the precision of a surgeon and the aggression of a champion.`,
      `found gaps that simply did not exist — three overtakes in four laps, including a stunning move around the outside.`,
      `demonstrated exactly why their driving style earns that description: ${_pick(["relentless","electric","unstoppable"])} from lights to chequered flag.`,
      `showed what this machine can do when all the stars align. P${finalPos} from P${c.gridPos} is a remarkable result.`,
    ])} Finishing P${finalPos} from P${c.gridPos} — the data will show it was earned.`);
  }

  // Defender story
  if(defenders.length>0) {
    const d=defenders[0];
    const startPos=pos.findIndex(e=>e.driver.id===d.driver.id)+1;
    drama.push(`THE DEFENCE: ${d.driver.name} fought tooth and nail to hold position for ${_pick(["eight","ten","six","twelve"])} consecutive laps — mirrors full of pressure, DRS attacks rebuffed, ${_pick([
      "every brake point a battle.",
      "using every millimetre of the track to close the door.",
      "the ${d.team.name} pit wall screaming delta times.",
      "the kind of racecraft that wins championships when it matters.",
    ])} Starting P${d.gridPos}, finishing P${startPos} — the ${d.team.name} points banker of the day.`);
  }

  // Rivalry moment
  if(rivalry) {
    drama.push(`${rivalry.desc.charAt(0).toUpperCase()+rivalry.desc.slice(1)} — ${winner.driver.name} extends their sprint advantage over ${p2?.driver.name||"P2"} but the margin was ${_pick(["tighter than the gap suggests","earned rather than given","hard-fought through every sector"])}.  Tomorrow's race means everything. The sprint is the prologue.`);
  }

  // Team-mate tension
  if(teamamateDuel) {
    drama.push(`${winner.driver.name} and team-mate ${teamamateDuel.driver.name} (P${pos.findIndex(e=>e.driver.id===teamamateDuel.driver.id)+1}) — the internal ${winner.team.name} championship is being contested as hard as the external one. ${_pick([
      "Radio silence between the two sides of the garage, but the data tells its own story.",
      "The team were clear: no team orders in the sprint. Both drivers raced it as such.",
      "The faster ${winner.driver.name} was today. Tomorrow it could flip.",
    ])}`,);
  }

  // Shock results
  if(surprise) {
    drama.push(`${surprise.driver.name} — the sprint's surprise package. ${_pick([
      "Started P"+surprise.gridPos+" and finished on the podium through a combination of pace, strategy, and sheer will.",
      "A result that changes their season narrative entirely.",
      "The ${surprise.team.name} debrief tonight will be filled with optimism. They found something this weekend.",
      "Nobody in the paddock predicted this result. The car and driver delivered when nobody was watching.",
    ])}`);
  }

  // DNF consequences
  if(dnfs.length) {
    const dNames=dnfs.map(e=>e.driver.name).join(" and ");
    drama.push(`RETIREMENTS: ${dNames} — ${_pick([
      `${dnfs.length===1?"their weekend":"the weekends of both drivers"} take a significant turn for the worse.`,
      `points left on the table that could prove decisive when the championship enters its final rounds.`,
      `the incidents will be reviewed: were they racing accidents or avoidable?`,
      `${dnfs[0].team.name} now ${_pick(["face a damage limitation exercise for tomorrow","will need a miracle in the race","must rebuild morale in the garage quickly"])}`,
    ])}`);
  }

  // Tomorrow preview
  const previews=[
    `TOMORROW: ${winner.driver.name} will start the grand prix from their qualifying position — P${qual.grid.findIndex(e=>e.driver.id===winner.driver.id)+1} on the grid, not P1. The sprint hierarchy does not carry over. Every advantage earned today in data — tyre wear patterns, engine temperature profiles, overtaking reference points — is the real currency heading into Sunday.`,
    `GRAND PRIX PREVIEW: The ${spLaps}-lap sprint was the opening statement. The race is the full argument. ${qual.grid[0]?.driver.name} starts from pole tomorrow — the sprint winner, if different, will need to fight through traffic. Strategy will differentiate. Nerves will be tested. Everything starts again in less than twenty-four hours.`,
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
    `🔬 ${session.name.toUpperCase()} — DAY ${session.days} REPORT\n\n${session.circuit}, ${session.dates}\n\n${topTeam.name} set the fastest time of the ${session.days}-day test as ${fastest.driver.name} clocked a ${fmtLap(fastest.bestLap)} to go quickest. But as every engineer in the paddock will tell you, February lap times are a story told in pencil — the real answers are hidden in the long-run data.`,
    `📋 PRE-SEASON TEST SUMMARY — ${session.circuit.toUpperCase()}\n\n${fastest.driver.name} topped the timesheets for ${topTeam.name} with a ${fmtLap(fastest.bestLap)}, but qualifying simulations on fresh tyres represent only one dimension of a complex, data-rich test. The ${session.days} days at ${session.circuit} have raised as many questions as they have answered — and that is exactly how the teams want it.`,
  ];

  const pace=[
    `PERFORMANCE PICTURE: ${second.driver.name} (${fmtLap(second.bestLap)}) and ${third.driver.name} (${fmtLap(third.bestLap)}) completed the top three. ${longRunSurprise?`However, ${longRunLeader.driver.name}'s long-run data told a very different story — their ${fmtLap(longRunLeader.longRun)} race simulation pace was the strongest in the field, raising questions about fuel loads and engine mapping during the quicker runs.`:`${fastest.driver.name} backed up the fastest lap with the strongest race pace too — ${topTeam.name} look genuinely formidable heading into the season opener.`}`,
    `The top three on outright lap time were ${fastest.driver.name}, ${second.driver.name} and ${third.driver.name} — but experienced engineers treat qualifying simulations in testing with significant scepticism. Fuel loads, tyre condition and cooling configurations vary wildly between runs, making direct comparisons misleading.`,
  ];

  const mileage=highMileage.length>0
    ?[`MILEAGE LEADERS: ${highMileage.map(r=>`${r.driver.name} (${r.laps} laps, ${r.team.name})`).join(", ")} accumulated the most running. Reliability data at this scale gives the engineers extremely high-quality degradation and wear models — an advantage that will pay dividends in the opening races.`]
    :[];

  const techDrama=[];
  if(issues.length>0){
    issues.slice(0,3).forEach(r=>{
      r.issues.forEach(iss=>{
        techDrama.push(`TECHNICAL ISSUE — ${r.team.name}: ${r.driver.name} was sidelined on Day ${iss.day} with a ${iss.type}. ${_pick(["The team managed to return to the track later in the session, but lost valuable running time.","Mechanics worked through the night to resolve the issue — the number of laps lost will concern the engineering team.","The root cause has been identified and the fix is straightforward, according to the team — but a component failure this early is never welcome news."])}`);
      });
    });
  }

  const analysis=[
    `ANALYST'S VIEW: ${_pick([
      `The ${topTeam.name} package looks balanced and fast. ${fastest.driver.name} was consistently at the sharp end and appeared comfortable with the car's behaviour in both high and low fuel configurations.`,
      `${results[Math.floor(results.length/4)].team.name} were quietly impressive throughout the test — their long runs were understated but the pace was there in the data. Don't be surprised if they are in the mix at the opening round.`,
      `The midfield picture remains unclear, which is exactly as the teams intended. ${results[Math.floor(results.length/2)].driver.name} turned heads with their consistency on long runs — ${results[Math.floor(results.length/2)].team.name} may have found something with this car.`,
    ])}`,
  ];

  const outlook=session.trackId==="spain"
    ?[`BARCELONA CONTEXT: The Circuit de Catalunya's characteristics — high tyre degradation, strong lateral loads and sensitivity to aerodynamic efficiency — make it a strong baseline for setup development. However, the February ambient temperatures (significantly cooler than race conditions) mean teams apply temperature correction factors to all data points. The real-world performance picture will only fully emerge at the Bahrain test.`]
    :session.trackId==="bahrain"
    ?[`BAHRAIN CONTEXT: This is the test that matters. The Bahrain International Circuit is the opening round of the 2027 season, run under floodlights with the exact ambient conditions teams will face in anger just weeks later. The data gathered here is the most race-representative of the winter. Any team that showed genuine race pace here — not just outright lap time — has reason for optimism. The 2027 season is almost upon us.`]
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
    `🔬 DAY 1 OF ${totalDays} — ${session.circuit.toUpperCase()} | ${conditions.icon} ${conditions.label}\n\nThe pit lane gates open, the engines fire, and the 2027 Formula 1 pre-season begins. Day one is never about lap times — it is about systems checks, installation laps and the first tentative feel of a new car on a new circuit. And yet, ${fastest.team.name} could not resist: ${fastest.driver.name} went quickest with a ${fmtLap(fastest.bestLap)}, setting the early benchmark${conditions.paceMod>0?" despite the compromised conditions":""}. A ${totalLaps}-lap day for the field as a whole.`,
    `DAY ONE | ${session.name.toUpperCase()}\n\n${conditions.icon} Conditions: ${conditions.label}. ${fastest.driver.name} (${fastest.team.name}) tops the timing screens on Day 1 with a ${fmtLap(fastest.bestLap)}, though context is everything — fuel loads are unknown, tyre specifications vary wildly, and half the field spent the morning on installation laps and aero mapping runs. The real data is in the long-run simulations happening off-camera.`,
  ] : isFinal ? [
    `🏁 DAY ${day} — FINAL DAY | ${session.circuit.toUpperCase()} | ${conditions.icon} ${conditions.label}\n\nThe last day of the ${totalDays}-day test and the pressure is on. This is when engineers want qualifying simulations — representative tyres, low fuel, the cars at their competitive best. ${fastest.driver.name} responded emphatically: ${fmtLap(fastest.bestLap)}, ${gap?`${gap}s clear of ${second?.driver.name||"P2"}`:""} — a statement time to carry into the season opener. The 2027 championship is almost upon us.`,
    `FINAL DAY SUMMARY — ${session.circuit.toUpperCase()}\n\n${conditions.icon} ${conditions.label}. Day ${day} of ${totalDays} and the paddock is buzzing — qualifying simulations, race simulations, late aero tests and final reliability checks. When the chequered flag drops on testing, ${fastest.driver.name} leads the overall timesheets with ${fmtLap(fastest.bestLap)}. Whether that represents genuine pace or a low-fuel, fresh-tyre gamble will be debated until the lights go out in ${session.trackId === "spain" ? "Bahrain" : "Melbourne"}.`,
  ] : [
    `📋 DAY ${day} OF ${totalDays} | ${session.circuit.toUpperCase()} | ${conditions.icon} ${conditions.label}\n\nThe midpoint of the ${totalDays}-day test, and the laptimes are beginning to sharpen. ${fastest.driver.name} led the timesheets with ${fmtLap(fastest.bestLap)}${conditions.paceMod>0?" — impressive given the conditions":""}. More importantly, the long-run data is building. Race simulations are beginning in earnest, and the true pecking order is slowly revealing itself to those with access to the timing data.`,
    `DAY ${day} REPORT | ${session.circuit}\n\n${conditions.icon} ${conditions.label}. A ${totalLaps}-lap day across the field — and the running is picking up. ${fastest.team.name} looked strongest today: ${fastest.driver.name} set a ${fmtLap(fastest.bestLap)} on what appeared to be a low-fuel qualifying run in the ${_pick(["morning","afternoon","final hour of the session"])}. ${second?.driver.name||"P2"} and ${third?.driver.name||"P3"} were not far away.`,
  ];

  // Pace analysis
  const paceAnalysis = [
    longRunSurprise
      ? `PACE PICTURE: The timing screens told one story; the fuel-adjusted data tells another. ${longRunLeader.driver.name} produced the most consistent long-run numbers of the day — ${fmtLap(longRunLeader.longRun)} average over an extended stint. That is the figure that will be circled in red in rival garages tonight. ${fastest.driver.name}'s quick time was on a ${_pick(["fresh set of softs","low-fuel single lap","clear track at the end of the session"])} — the race pace picture is more complex.`
      : `PACE PICTURE: ${fastest.driver.name} led both the qualifying simulation and long-run charts today. Back-to-back sessions on different fuel loads and it was consistently ${fastest.team.name} at the front. The data correlation from the ${conditions.label.toLowerCase()} conditions will need careful interpretation, but the headline is clear.`,
    `The gap between ${fastest.driver.name} and ${second?.driver.name||"P2"} was ${gap?gap+"s":"marginal"} on outright pace${conditions.paceMod>0?", though the "+conditions.label.toLowerCase()+" conditions make direct comparison difficult":""}.${longRunSurprise?" On long runs, ${longRunLeader.driver.name} looked a different proposition entirely.":""}`,
  ];

  // Technical incidents
  const techLines = [];
  if (majorIssues.length > 0) {
    majorIssues.forEach(inc => {
      techLines.push(`⚠️ TECHNICAL STOPPAGE — ${inc.team.name}: ${inc.driver.name} was halted by a ${inc.issue.type} during the ${inc.issue.session.toLowerCase()} session, losing an estimated ${inc.issue.lapLost} laps of running. The team have identified the root cause and are working on a resolution overnight. Major interruptions this early in testing are a concern — reliability data at this stage is as important as lap time.`);
    });
  }
  if (minorIssues.length > 0 && techLines.length < 2) {
    const mi = minorIssues[0];
    techLines.push(`MINOR ISSUE — ${mi.team.name}: ${mi.driver.name} reported a ${mi.issue.type} (${mi.issue.session.toLowerCase()}) but returned to the track after a brief stop. ${mi.issue.lapLost} laps lost — frustrating but not catastrophic. The team will review the data overnight.`);
  }
  if (incidents.length === 0) {
    techLines.push(`A clean day in terms of reliability — ${totalLaps} laps completed across the field with no significant stoppages. ${fastest.team.name}'s mechanics can allow themselves a cautious smile. Building confidence in the package is as valuable as any lap time.`);
  }

  // Mileage / storylines
  const storyLines = [];
  if (highLaps.length > 0) {
    storyLines.push(`MILEAGE LEADERS: ${highLaps.map(r=>`${r.driver.name} (${r.laps} laps)`).join(", ")} accumulated the most running today. ${highLaps[0].driver.name} in particular was relentless — long stints, back-to-back sets, different compounds. The tyre wear data they are generating will be invaluable come race day.`);
  }
  if (surpriseP && !isFirst) {
    storyLines.push(`THE TALKING POINT: ${surpriseP.driver.name} was the name on everyone's lips in the paddock. A genuine qualifying simulation lap elevated them to P${results.indexOf(surpriseP)+1} — ${_pick(["a result that surprised even their own engineers","a time that will be studied by rivals in detail","raising questions about whether it was representative or something more significant"])}. Watch this space.`);
  }

  // Day-end look ahead
  const lookAheads = isFinal ? [
    `With testing concluded, the teams pack up and prepare for ${session.trackId==="spain"?"the second test in Bahrain":"the season opener"}. The laptimes will dominate discussion — but as every experienced engineer will say, the real work happens in the data warehouse, not on the timing screens.`,
  ] : isFirst ? [
    `Looking ahead to Day ${day+1}: teams will begin race simulations in earnest. The setup baseline from today's runs gives engineers the foundation they need. Expect more representative pace tomorrow — and potentially some genuine surprises.`,
    `Day ${day+1} will see teams shift focus: from system validation to performance development. The overnight data crunching will produce a long list of setup changes. The circuit should rubber-in further overnight, and lap times will drop accordingly.`,
  ] : [
    `Final day tomorrow: qualifying simulations, final race runs and the last chance to assess the competition. The paddock will be watching closely — every tenth matters when the season is days away.`,
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
    `Q1 — ${track.circuit.toUpperCase()} | 18 MINUTES, 20 DRIVERS, FIVE WILL NOT SURVIVE\n\n${fastest.driver.name} led ${fastest.team.name} at the top of Q1 with a commanding ${_pick(["first run banker","mid-session flyer","late improvement run"])}. The ${track.street?"unforgiving walls":"circuit"} claimed its usual victims in the lower half of the order, but the headline is the gap to ${second?.driver.name||"P2"} — ${gap}s — which may or may not represent a genuine performance advantage.`,
    `Q1 REPORT — ${track.name.toUpperCase()}\n\n${fastest.driver.name} goes fastest in Q1 at ${track.circuit}. But this is survival qualifying — the task is not to be quickest, it is to be in the top fifteen. The real drama plays out in the elimination zone, where fortunes can turn on a single mistake.`,
    `FIRST BLOOD — ${fastest.driver.name} (${fastest.team.name}) tops Q1 at ${track.circuit}. ${_pick([
      "A clean session for the championship leader — exactly what was needed.",
      "A session managed perfectly by the team — neither showing everything nor risking anything.",
      "Fastest but by no means untouchable — the tyre data from this run will be picked apart by rivals tonight.",
    ])}`,
  ];

  const drama=[];
  if(bigBump) drama.push(`THE SHOCK: ${bigBump.driver.name} fails to advance. It is the qualifying story of the weekend — a driver in form, a car that has been quick in practice, and yet here they are: eliminated in Q1. ${_pick([
    `The ${bigBump.team.name} team will review every corner of every lap tonight.`,
    `The championship implications are significant. ${bigBump.driver.name} needed points from this race.`,
    `Questions will be asked about tyres, traffic, and whether the setup direction from Friday was simply wrong.`,
  ])}`);
  if(tight) drama.push(`The cut between P15 and P16 was ${_pick(["clinical","brutal","unforgiving"])} — ${_pick([
    "thousandths, not tenths, was the difference between a race and an early Sunday.",
    "the driver who survived will celebrate that lap for the rest of the weekend.",
    "both drivers gave absolutely everything. One will contest Q2. One will not.",
    "the kind of margin that keeps engineers staring at data at three in the morning.",
  ])}`);
  if(darkHorse) drama.push(`Worth watching: ${darkHorse.driver.name} (${darkHorse.team.name}) made Q2 look comfortable. Their sector times through ${track.type==="technical"?"the technical middle sector":"the high-speed section"} were a match for cars from supposedly faster teams. Something is working this weekend.`);
  drama.push(`The five eliminated: ${elim.map(e=>e.driver.name).join(", ")}. ${_pick([
    "Each with their own story of a session undone.",
    "All five will study the data and find the tenths that cost them. Too late for this race.",
    "The gap between them and safety ranged from marginal to significant — the order told its own story.",
    "Three teams lose drivers to Q1 today — a difficult afternoon of debrief conversations awaits.",
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
    `Q2 — ${track.circuit.toUpperCase()} | 15 MINUTES, 15 DRIVERS, FIVE SPOTS TO FILL IN Q3\n\n${fastest.driver.name} leads Q2 for ${fastest.team.name} as the session unfolds into a ${_pick(["tense","chaotic","strategically fascinating","brutally simple"])} fifteen minutes. The top ten advance; the bottom five go home. But this session carries a hidden dimension: the compound you set your fastest time on is the compound you start the race on tomorrow.`,
    `Q2 REPORT — ${track.name.toUpperCase()}\n\nFifteen drivers, fifteen minutes, and a tyre decision embedded in every flying lap. ${fastest.driver.name} led the way, but the tyre choices being made in the garages right now could define Sunday's race entirely. ${q3Drivers.slice(0,3).map(e=>e.driver.name).join(", ")} safely through — now they prepare for the shootout.`,
    `${fastest.driver.name} LEADS Q2 — but the story of this session isn't the lap time. It's the compound. ${_pick([
      `At least four drivers advanced to Q3 on mediums — a significant strategic variable for tomorrow.`,
      `Several teams chose hard tyres to make it through — a race-starting advantage if it works, a pace disadvantage if it doesn't.`,
      `The tyre allocation decisions made in the next eight minutes will be debated for years if they prove decisive.`,
    ])}`,
  ];

  const drama=[];
  if(shockElim) drama.push(`ELIMINATED — ${shockElim.driver.name}. The ${shockElim.team.name} driver, who had looked competitive all weekend, fails to make Q3. ${_pick([
    `A tyre temperature issue on the final run — the compound never came alive in the final sector.`,
    `The team's decision to save a set of softs for the race backfired disastrously.`,
    `An impeding incident in the final minutes destroyed their last chance at improvement.`,
    `Starting from P${shockElim.q2Pos+10||11} is not impossible, but it requires a perfect race and significant chaos ahead.`,
    `The championship damage from this qualifying result is substantial. A recovery drive is the only option now.`,
  ])}`);
  if(tight) drama.push(`P10 and P11 — the most painful borderline in motorsport. ${sorted[9]?.driver.name} advances; ${sorted[10]?.driver.name} does not. The gap was ${gap}s. ${_pick([
    "A tow denied. A traffic incident at the wrong moment. A tenth found or lost somewhere nobody expected.",
    "The kind of result that changes a team's entire weekend outlook.",
    "Tomorrow, the driver starting P11 faces a much longer route to points.",
    "Every driver on the bubble gave everything. The timing screen was the only judge.",
  ])}`);
  if(tyreTheme) drama.push(`The tyre strategies visible in Q2: ${q3Drivers.slice(0,3).map(e=>`${e.driver.name.split(" ").pop()} (${_pick(["softs","mediums"])})`).join(", ")} — this creates ${_pick([
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
    `Q3 — ${track.circuit.toUpperCase()} | THE POLE POSITION SHOOTOUT\n\n${pole.driver.name}. Pole position. ${_pick([
      `A lap that silenced the paddock — ${gap}s to ${p2?.driver.name||"P2"}.`,
      `The ${pole.team.name} driver at their absolute best when it matters most.`,
      `A lap built from three perfect sectors — every corner a decision, every apex hit perfectly.`,
    ])} Starting from the front at ${track.circuit} is ${track.od>70?"not an automatic advantage — overtaking is possible but difficult":"a significant tactical weapon for tomorrow"}.`,
    `POLE: ${pole.driver.name} (${pole.team.name}) — ${fmtLap?fmtLap(pole.score*0.011+80):gap+"s gap"} — ${track.name.toUpperCase()}\n\n${_pick([
      `${gap}s clear of ${p2?.driver.name||"P2"} — a ${tight?"razor-thin":dominant?"commanding":"clear"} advantage heading into Sunday.`,
      `The team radio erupts. The garage erupts. ${pole.driver.name} pumps their fist through the cockpit opening.`,
      `Pole position number ${_pick(["three","seven","twelve","twenty-one","four"])} of their career — and perhaps the most important this season.`,
    ])}`,
    `IT'S ${pole.driver.name.toUpperCase()} ON POLE POSITION AT ${track.circuit.toUpperCase()}!\n\n${_pick([
      `A ${_pick(["masterpiece","statement","tour de force","perfect response to a difficult weekend"])} of a qualifying lap.`,
      `Built in the final sector — where others found the limit, ${pole.driver.name} found another tenth.`,
      `The final flying lap. Everything on the line. ${pole.driver.name} delivered.`,
    ])} The gap to ${p2?.driver.name||"P2"}: ${gap}s. On a day like today, that feels like a mile.`,
  ];

  const analysis=[
    sameTeam
      ?`${pole.team.name} lock out the front row — a ${_pick(["stunning","clinical","overwhelming","authoritative"])} team performance. ${p2?.driver.name} within ${gap}s of their team-mate means the garage dynamic tomorrow will be tense. Who blinks at Turn 1?`
      :`Front row: ${pole.driver.name} (${pole.team.name}) and ${p2?.driver.name} (${p2?.team.name}). ${_pick([
        "Two different strategies, two different approaches, one shared ambition.",
        "The clean side of the grid gives pole a marginal grip advantage at the start.",
        "The inside line into Turn 1 belongs to pole — unless something dramatic happens at the formation lap.",
      ])}`,
    rivalry
      ?`${rivalry.desc.charAt(0).toUpperCase()+rivalry.desc.slice(1)} — ${pole.driver.name} has the edge going into Sunday but ${p2?.driver.name} knows this race is decided over 57 laps, not over one flying lap at the end of qualifying.`
      :`${p3?`P3: ${p3.driver.name} (${p3.team.name}) — `:""}${_pick([
        "a starting position that has delivered race victories at this circuit in the past.",
        "a perfect platform if the front row makes contact at the start.",
        "the undercut target. If pit stop timing favours them, ${p3?p3.driver.name:'the P3 driver'} could be leading by lap thirty.",
      ])}`,
  ];

  const riskItems=[
    `WHAT COULD DECIDE TOMORROW: ${_pick([
      `Safety car probability at ${track.circuit} is historically ${track.hasSC||Math.random()<0.5?"high — any neutralisation period will compress the field and reset the race":"low — unless the lap 1 chaos everyone fears materialises"}. Whoever comes out of a safety car restart in front usually wins.`,
      `Tyre compound strategies diverge sharply from row three back. If the one-stoppers can make it work, the two-stopping front-runners face a nightmare of timing calculations.`,
      `${track.night?"Night conditions change tyres and strategy. The optimal pit window is compressed — small mistakes cost big.":`${track.street?"Pit lane entry is tight — a slow stop or a double-stack could cost a full second.":`Weather radar shows ${track.wr>40?"a significant rain risk tomorrow. If it comes, all of this qualifying data is irrelevant.":"no immediate threat but conditions can change quickly."}`}`}`,
    ])}`,
  ];

  return [_pick(intros), _pick(analysis), ...riskItems].filter(Boolean);
}


// ║  Reusable React components: Bar, MentalBar, TrackPicker, RivalPicker,  ║
// ║  STAGE_DEFS: the 7 Croft & Brundle commentary stages (lights out →     ║
const STAGE_DEFS=[
  {key:"start",   title:"LIGHTS OUT",      emoji:"🚦",color:"#E8002D",lapHint:"Laps 1–5"},
  {key:"early",   title:"EARLY RUNNING",   emoji:"⚡",color:"#FF8844",lapHint:"Laps 6–20"},
  {key:"pits",    title:"PIT WINDOW",      emoji:"🔄",color:"#4488FF",lapHint:"Laps 20–55%"},
  {key:"mid",     title:"MID-RACE",        emoji:"🔥",color:"#FFC906",lapHint:"40–65%"},
  {key:"midfield",title:"MIDFIELD MELEE",  emoji:"🏎️",color:"#BB66FF",lapHint:"P8–P22"},
  {key:"closing", title:"CLOSING LAPS",    emoji:"🏁",color:"#44CC88",lapHint:"Final 20%"},
  {key:"podium",  title:"PODIUM",          emoji:"🏆",color:"#FFD700",lapHint:"Post-Race"},
];

// ===================== MAIN APP =====================


// ║  F1Sim is the root React component. All state lives here.               ║
// ║  State:   drivers, teams, track, view, qual, sprint, race, stages,      ║
// ║                                                                          ║
// ║           → testing → multisim → championship                           ║
// ║  Persistence: localStorage keys:                                         ║
// ║    f1sim_teams   — serialised team array                                ║

// ║  Shows on first load. F1 2027 is the only active series; F2/F3/F4/     ║
// ║  ready to be activated in future versions.                               ║

// ║  Anonymised race simulation data is sent to a Supabase backend.         ║
// ║  local model via Bayesian blending. All data is opt-in and anonymous.   ║


// Replace these with your own Supabase project URL and anon key.
// See docs/SUPABASE_SETUP.md for the full setup guide.
const SUPABASE_URL  = "https://tdsmjrbuplbjnajdzjnu.supabase.co";
const SUPABASE_KEY  = "sb_publishable_XsC9JcwIvUb1ns7qeFegXw_CzsjStu2";
const COMMUNITY_ENABLED_BY_DEFAULT = true;   // on by default - repo is private


const sbHeaders = () => ({
  "apikey": SUPABASE_KEY,
  "Authorization": `Bearer ${SUPABASE_KEY}`,
  "Content-Type": "application/json",
  "Prefer": "return=minimal",
});

async function sbInsert(table, row) {
  if(SUPABASE_URL.includes("YOUR_PROJECT")||SUPABASE_KEY.includes("YOUR_")||!SUPABASE_KEY) return null;
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
      method: "POST", headers: sbHeaders(), body: JSON.stringify(row),
    });
    return r.ok;
  } catch(e) { return null; }
}

async function sbSelect(table, filters = "", limit = 500) {
  if(SUPABASE_URL.includes("YOUR_PROJECT")||SUPABASE_KEY.includes("YOUR_")||!SUPABASE_KEY) return null;
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/${table}?select=*${filters}&limit=${limit}`,
      { headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}` } }
    );
    return r.ok ? await r.json() : null;
  } catch(e) { return null; }
}


function getSessionId() {
  let id;
  try { id = localStorage.getItem("f1sim_session"); } catch(e) {}
  if(!id) {
    id = "s_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2,9);
    try { localStorage.setItem("f1sim_session", id); } catch(e) {}
  }
  return id;
}


// Blends local Monte Carlo predictions with community aggregate data.
// α = community weight, grows with sample size up to 0.40 (40%)
// Below 30 community samples, community data is not trusted enough to blend.
function fuseWithCommunity(localResults, communityRows, circuitId) {
  if(!communityRows||communityRows.length<30) return localResults;
  const MIN_SAMPLES = 30, MAX_ALPHA = 0.40;
  const totalSamples = communityRows.reduce((a,r)=>a+(r.sample_count||0),0);
  const alpha = Math.min(MAX_ALPHA, totalSamples / 500) * (totalSamples>=MIN_SAMPLES?1:0);
  if(alpha<0.01) return localResults;
  const commMap = {};
  communityRows.forEach(r=>{ commMap[r.driver_id]={winPct:r.avg_win_pct, podPct:r.avg_podium_pct, avgPos:r.avg_position}; });
  return localResults.map(r=>{
    const c=commMap[r.driver?.id];
    if(!c) return r;
    return {
      ...r,
      winPct:    (1-alpha)*r.winPct    + alpha*(c.winPct||r.winPct),
      podiumPct: (1-alpha)*r.podiumPct + alpha*(c.podPct||r.podiumPct),
      avgPos:    (1-alpha)*r.avgPos    + alpha*(c.avgPos||r.avgPos),
      communityFused: true,
    };
  }).sort((a,b)=>a.avgPos-b.avgPos);
}

// ===================== F2 DATA =====================

const F2_PARTS = {
  engineMapping: [
    {id:"f2em_power",      name:"Power Mapping",          spec:"Qualifying",
     pace:9, reliability:5, fuel:-2, straightSpeed:9,
     description:"Maximum Mechachrome output for raw lap time. Exceptional in qualifying but demands careful temperature management — sustained full-power runs across race distances risk premature wear."},
    {id:"f2em_balanced",   name:"Balanced Mapping",       spec:"Standard",
     pace:6, reliability:8, fuel:0, straightSpeed:6,
     description:"The default Mechachrome configuration. Reliable, predictable, competitive in all conditions. The benchmark used by most teams on their first visit to any circuit."},
    {id:"f2em_economy",    name:"Economy Mapping",        spec:"Race",
     pace:3, reliability:10, fuel:2, straightSpeed:4,
     description:"Fuel-efficient and mechanically gentle. Loses time on straights but preserves the engine across sprint and feature race weekends. Ideal when reliability is paramount."},
    {id:"f2em_aggressive", name:"Aggressive Deployment",  spec:"Attack",
     pace:8, reliability:6, fuel:-1, straightSpeed:8,
     description:"High torque deployment out of slow corners. Strong in opening laps and wheel-to-wheel battles. Higher thermal stress on drivetrain — not recommended for feature race distances."},
    {id:"f2em_thermal",    name:"Thermal Management",     spec:"Endurance",
     pace:4, reliability:9, fuel:1, straightSpeed:5,
     description:"Actively manages cylinder temperatures to reduce DNF risk. Trades some outright pace for significantly improved mechanical longevity — essential on high-degradation weekends."},
    {id:"f2em_overtake",   name:"Overtake Mode",          spec:"Sprint",
     pace:7, reliability:6, fuel:-1, straightSpeed:10,
     description:"Maximum straight-line burst mode. Transforms DRS zones into decisive overtaking opportunities during sprint races. Cannot be sustained indefinitely without drivetrain risk."},
  ],
  aeroSetup: [
    {id:"f2ae_high",       name:"High Downforce Setup",   spec:"Monaco/Singapore",
     cornerSpeed:9, straightSpeed:-4, tyreWear:1, wetPerformance:2,
     circuitBonus:{street:3,technical:2,"high-downforce":2},
     description:"Maximum wing angles for slow-speed grip. Dominates Monaco and Singapore where overtaking is near-impossible — corner exit speed and mechanical grip win races here."},
    {id:"f2ae_medium",     name:"Medium Downforce Setup", spec:"Standard",
     cornerSpeed:6, straightSpeed:0, tyreWear:0, wetPerformance:1,
     circuitBonus:{mixed:2,technical:1},
     description:"The benchmark F2 aero configuration. Balanced between straight-line speed and cornering grip. Competitive at every circuit without being definitively optimal at any."},
    {id:"f2ae_low",        name:"Low Drag Setup",         spec:"Monza/Baku",
     cornerSpeed:2, straightSpeed:7, tyreWear:-1, wetPerformance:-2,
     circuitBonus:{"low-downforce":5,"high-speed":4},
     description:"Minimum wing angles for maximum straight-line speed. Blistering at Monza and Baku. A chronic understeer liability in slow and medium-speed corners."},
    {id:"f2ae_quali",      name:"Qualifying Trim",        spec:"Single Lap",
     cornerSpeed:8, straightSpeed:2, tyreWear:2, wetPerformance:0,
     circuitBonus:{mixed:3,technical:3},
     description:"Optimised for a single timed lap. Every surface cleaned for reduced drag at the cost of race tyre life. The setup that wins poles — and sometimes destroys rubber by lap 10."},
    {id:"f2ae_race",       name:"Race Setup",             spec:"Feature Race",
     cornerSpeed:5, straightSpeed:1, tyreWear:-2, wetPerformance:1,
     circuitBonus:{"high-downforce":2,mixed:2},
     description:"Engineered for tyre preservation across full feature race distance. Slightly slower on a single lap but consistently delivers podium finishes when rivals struggle late on."},
    {id:"f2ae_wet",        name:"Wet Weather Trim",       spec:"Rain",
     cornerSpeed:7, straightSpeed:-2, tyreWear:0, wetPerformance:5,
     circuitBonus:{},
     description:"Maximum downforce for wet conditions. In intermediates and heavy rain this setup turns a midfield car into a front-runner. Too much drag and instability in the dry."},
  ],
  suspensionTune: [
    {id:"f2sus_stiff",     name:"Stiff Qualifying Setup", spec:"Smooth Circuits",
     pace:8, tyreWear:3, consistency:-2, wetPerformance:-2,
     description:"Rigid geometry for maximum single-lap response. The car feels planted through high-speed corners. Burns through front tyres — short sprint distances only."},
    {id:"f2sus_balanced",  name:"Balanced Race Setup",    spec:"Standard",
     pace:5, tyreWear:0, consistency:3, wetPerformance:0,
     description:"The engineers' starting point at any new circuit. Predictable in every condition, consistent tyre wear, easy for drivers to build confidence during practice."},
    {id:"f2sus_soft",      name:"Soft Ride Height",       spec:"Street/Bumpy",
     pace:3, tyreWear:-2, consistency:4, wetPerformance:2,
     description:"Compliant setup for bumpy street circuits. Absorbs kerb impacts well. Slightly slower on smooth tarmac but preferred on circuits like Baku and Monaco."},
    {id:"f2sus_adaptive",  name:"Adaptive Damper Setup",  spec:"Advanced",
     pace:7, tyreWear:-1, consistency:4, wetPerformance:2,
     description:"Computer-adjusted dampers react to circuit surface in real time. Near-stiff single-lap pace with significantly better tyre life and consistency across longer stints."},
    {id:"f2sus_highspeed", name:"High-Speed Stability",   spec:"Power Circuits",
     pace:6, tyreWear:1, consistency:2, wetPerformance:-1,
     description:"Geometry optimised for stability through fast corners. The setup of choice at Spa, Monza, and Silverstone where the car needs to feel planted at 260+ km/h."},
    {id:"f2sus_street",    name:"Street Circuit Spec",    spec:"Street",
     pace:4, tyreWear:-1, consistency:3, wetPerformance:3,
     description:"High ride height and compliant dampers for unpredictable street surfaces. Absorbs the worst kerbs while keeping the car out of the barriers. Sacrifices pace, saves the car."},
  ],
  differential: [
    {id:"f2df_locked",     name:"High Lock Differential", spec:"Traction",
     pace:7, tyreWear:2, cornerExit:9,
     description:"Maximum lock helps traction out of hairpins. Phenomenal corner exit speed at the cost of inner tyre scrub. Perfect for circuits with multiple slow-speed turns."},
    {id:"f2df_standard",   name:"Standard Differential",  spec:"Balanced",
     pace:5, tyreWear:0, cornerExit:6,
     description:"The default F2 differential specification. No strong philosophy in either direction — teams run this as baseline and adjust from real-world data after practice sessions."},
    {id:"f2df_open",       name:"Open Differential",      spec:"Cornering",
     pace:4, tyreWear:-1, cornerExit:3,
     description:"Minimal lock for maximum rotation mid-corner. Rewards trail braking and aggressive rotation into slow corners. Slower on pure exit, exceptional entry speed."},
    {id:"f2df_torque",     name:"Torque Vectoring Setup",  spec:"Active",
     pace:8, tyreWear:1, cornerExit:8,
     description:"Active torque distribution adjusts independently per rear wheel. Combines corner entry precision with exit traction. Complex to calibrate but rewarding when dialled in."},
    {id:"f2df_conservative",name:"Conservative Lock",     spec:"Tyre Life",
     pace:3, tyreWear:-2, cornerExit:5,
     description:"Low-lock differential primarily intended to preserve rear tyre life over feature race distances. The tyre whisperer's choice when rivals are struggling in the final stint."},
    {id:"f2df_sprint",     name:"Sprint Race Setup",       spec:"Short Distance",
     pace:9, tyreWear:3, cornerExit:10,
     description:"All-out attack differential for short sprint races. Maximum traction at every corner exit — completely unsuitable for feature race distances where the rear tyres would overheat."},
  ],
  brakeConfig: [
    {id:"f2bk_early",      name:"Early Braking Bias",     spec:"Conservative",
     pace:3, consistency:5, wetPerformance:2,
     description:"Safe brake bias for reliability and consistency. Easier on brake temperatures over long stints. More forgiving in traffic — preferred by drivers still learning a new circuit."},
    {id:"f2bk_standard",   name:"Standard Brake Setup",   spec:"Balanced",
     pace:5, consistency:3, wetPerformance:1,
     description:"Balanced brake bias across all four corners. No strong front/rear opinion. Works in all conditions and gives drivers a predictable baseline to build from in each session."},
    {id:"f2bk_aggressive", name:"Aggressive Brake Bias",  spec:"Performance",
     pace:8, consistency:0, wetPerformance:-1,
     description:"Forward bias for maximum deceleration at turn-in. Spectacular lap times when executed perfectly. Over-drives front pads and becomes very difficult to manage in wet conditions."},
    {id:"f2bk_latestop",   name:"Late-Stop Braking",      spec:"Overtaking",
     pace:7, consistency:1, wetPerformance:0,
     description:"Tuned for late-braking overtake manoeuvres. Maximum stopping power at the threshold — the signature weapon of a charger-style driver in wheel-to-wheel combat."},
    {id:"f2bk_thermal",    name:"Thermal Management",     spec:"Endurance",
     pace:4, consistency:4, wetPerformance:2,
     description:"Actively manages brake temperatures across a full race. Slightly compromised absolute performance but eliminates the risk of brake fade in the closing laps on hot circuits."},
    {id:"f2bk_carbon",     name:"Carbon Compound Setup",  spec:"Advanced",
     pace:9, consistency:-1, wetPerformance:-2,
     description:"Maximum performance carbon compound with aggressive bias. Fastest in the dry on fresh pads. Unforgiving in changing conditions or when pad temperatures fall outside the operating window."},
  ],
};

const F2_TEAM_DEFAULT_SETUPS = {
  prema:       {engineMapping:"f2em_power",     aeroSetup:"f2ae_quali",  suspensionTune:"f2sus_stiff",     differential:"f2df_torque",       brakeConfig:"f2bk_aggressive"},
  dams:        {engineMapping:"f2em_balanced",  aeroSetup:"f2ae_medium", suspensionTune:"f2sus_balanced",  differential:"f2df_standard",     brakeConfig:"f2bk_standard"},
  art:         {engineMapping:"f2em_balanced",  aeroSetup:"f2ae_race",   suspensionTune:"f2sus_adaptive",  differential:"f2df_locked",       brakeConfig:"f2bk_latestop"},
  virtuosi:    {engineMapping:"f2em_aggressive",aeroSetup:"f2ae_race",   suspensionTune:"f2sus_adaptive",  differential:"f2df_locked",       brakeConfig:"f2bk_latestop"},
  carlin:      {engineMapping:"f2em_overtake",  aeroSetup:"f2ae_medium", suspensionTune:"f2sus_balanced",  differential:"f2df_standard",     brakeConfig:"f2bk_latestop"},
  hitech:      {engineMapping:"f2em_power",     aeroSetup:"f2ae_quali",  suspensionTune:"f2sus_stiff",     differential:"f2df_torque",       brakeConfig:"f2bk_carbon"},
  mp:          {engineMapping:"f2em_thermal",   aeroSetup:"f2ae_medium", suspensionTune:"f2sus_soft",      differential:"f2df_conservative", brakeConfig:"f2bk_thermal"},
  invicta:     {engineMapping:"f2em_balanced",  aeroSetup:"f2ae_race",   suspensionTune:"f2sus_adaptive",  differential:"f2df_standard",     brakeConfig:"f2bk_standard"},
  vamersfoort: {engineMapping:"f2em_economy",   aeroSetup:"f2ae_medium", suspensionTune:"f2sus_balanced",  differential:"f2df_conservative", brakeConfig:"f2bk_early"},
  trident:     {engineMapping:"f2em_aggressive",aeroSetup:"f2ae_medium", suspensionTune:"f2sus_highspeed", differential:"f2df_standard",     brakeConfig:"f2bk_standard"},
};

function getF2TeamStats(team) {
  const p = team.parts || {};
  const em  = F2_PARTS.engineMapping.find(x=>x.id===p.engineMapping)  || F2_PARTS.engineMapping[1];
  const ae  = F2_PARTS.aeroSetup.find(x=>x.id===p.aeroSetup)          || F2_PARTS.aeroSetup[1];
  const sus = F2_PARTS.suspensionTune.find(x=>x.id===p.suspensionTune) || F2_PARTS.suspensionTune[1];
  const df  = F2_PARTS.differential.find(x=>x.id===p.differential)    || F2_PARTS.differential[1];
  const bk  = F2_PARTS.brakeConfig.find(x=>x.id===p.brakeConfig)      || F2_PARTS.brakeConfig[1];
  const rawPace = 55 + (em.pace||5)*1.5 + (ae.cornerSpeed||5)*0.8 + Math.max(0,ae.straightSpeed||0)*0.5 + (sus.pace||4)*0.6 + (df.pace||4)*0.5 + (bk.pace||4)*0.4;
  const rawRel  = 55 + (em.reliability||7)*2.5 + (df.tyreWear>2?-4:0);
  const tyreLife = 55 + (sus.tyreWear||0)*(-4) + (ae.tyreWear||0)*(-3) + (df.tyreWear||0)*(-2);
  const wetBonus = (ae.wetPerformance||0)*1.5 + (sus.wetPerformance||0)*1.2 + (bk.wetPerformance||0);
  return {
    carPace:     Math.round(Math.max(50,Math.min(99,rawPace))),
    reliability: Math.round(Math.max(50,Math.min(99,rawRel))),
    pitSpeed:    team.basePitSpeed||80,
    tyreLife:    Math.round(Math.max(30,Math.min(90,tyreLife))),
    wetBonus:    Math.round(wetBonus),
    cornerBonus: (ae.cornerSpeed||5)+(sus.pace||4)*0.5+(df.cornerExit||5)*0.3,
    straightBonus:(ae.straightSpeed||0)+(em.straightSpeed||5)*0.8,
    aeroCircuitBonus: ae.circuitBonus||{},
    em,ae,sus,df,bk,
  };
}

const F2_TEAMS = [
  {id:"prema",      name:"Prema Racing",        abbr:"PRM",color:"#CC0000",tc:"#fff",basePitSpeed:88,engine:"Mechachrome",strategy:"aggressive_two",parts:{...F2_TEAM_DEFAULT_SETUPS.prema}},
  {id:"dams",       name:"DAMS",                abbr:"DAM",color:"#E5C31C",tc:"#000",basePitSpeed:82,engine:"Mechachrome",strategy:"one_stop",      parts:{...F2_TEAM_DEFAULT_SETUPS.dams}},
  {id:"art",        name:"ART Grand Prix",      abbr:"ART",color:"#1A1A1A",tc:"#FFD700",basePitSpeed:83,engine:"Mechachrome",strategy:"undercut_king",parts:{...F2_TEAM_DEFAULT_SETUPS.art}},
  {id:"virtuosi",   name:"Virtuosi Racing",     abbr:"VRT",color:"#2255BB",tc:"#fff",basePitSpeed:84,engine:"Mechachrome",strategy:"reactive",       parts:{...F2_TEAM_DEFAULT_SETUPS.virtuosi}},
  {id:"carlin",     name:"Carlin Motorsport",   abbr:"CAR",color:"#FF6B00",tc:"#fff",basePitSpeed:80,engine:"Mechachrome",strategy:"overcut",        parts:{...F2_TEAM_DEFAULT_SETUPS.carlin}},
  {id:"hitech",     name:"Hitech Grand Prix",   abbr:"HIT",color:"#BB0033",tc:"#fff",basePitSpeed:81,engine:"Mechachrome",strategy:"aggressive_two", parts:{...F2_TEAM_DEFAULT_SETUPS.hitech}},
  {id:"mp",         name:"MP Motorsport",       abbr:"MPM",color:"#DD2244",tc:"#fff",basePitSpeed:79,engine:"Mechachrome",strategy:"fuel_save",       parts:{...F2_TEAM_DEFAULT_SETUPS.mp}},
  {id:"invicta",    name:"Invicta Racing",      abbr:"INV",color:"#006644",tc:"#fff",basePitSpeed:80,engine:"Mechachrome",strategy:"safety_car",      parts:{...F2_TEAM_DEFAULT_SETUPS.invicta}},
  {id:"vamersfoort",name:"Van Amersfoort",      abbr:"VAR",color:"#0044CC",tc:"#fff",basePitSpeed:78,engine:"Mechachrome",strategy:"tyre_banker",     parts:{...F2_TEAM_DEFAULT_SETUPS.vamersfoort}},
  {id:"trident",    name:"Trident Motorsport",  abbr:"TRI",color:"#004488",tc:"#fff",basePitSpeed:79,engine:"Mechachrome",strategy:"reactive",        parts:{...F2_TEAM_DEFAULT_SETUPS.trident}},
];

const F2_DRIVERS = [
  {id:"f2_bearman",   name:"Oliver Bearman",    abbr:"BEA",num:1, teamId:"prema",       pace:88,consistency:85,wet:82,overtaking:86,defense:82,experience:68,mental:8, flag:"🇬🇧",goodTracks:["italy","britain","bahrain"],    badTracks:["monaco","singapore","japan"],  style:"aggressive",rivals:["f2_doohan"]},
  {id:"f2_villagomez",name:"Rafael Villagómez", abbr:"VIL",num:2, teamId:"prema",       pace:78,consistency:76,wet:74,overtaking:77,defense:74,experience:52,mental:6, flag:"🇲🇽",goodTracks:["mexico","spain","bahrain"],     badTracks:["monaco","italy","azerbaijan"], style:"charger",  rivals:[]},
  {id:"f2_maloney",   name:"Zane Maloney",      abbr:"MAL",num:3, teamId:"dams",        pace:82,consistency:80,wet:79,overtaking:81,defense:78,experience:64,mental:7, flag:"🇧🇧",goodTracks:["bahrain","usa","austria"],      badTracks:["monaco","singapore","japan"],  style:"charger",  rivals:["f2_bearman"]},
  {id:"f2_dellarosa", name:"Emidio Della Rosa", abbr:"EDR",num:4, teamId:"dams",        pace:76,consistency:74,wet:72,overtaking:74,defense:72,experience:48,mental:6, flag:"🇮🇹",goodTracks:["italy","spain","hungary"],     badTracks:["monaco","azerbaijan","canada"],style:"technical",rivals:[]},
  {id:"f2_maini",     name:"Kush Maini",        abbr:"MAI",num:5, teamId:"art",         pace:81,consistency:82,wet:80,overtaking:79,defense:80,experience:70,mental:7, flag:"🇮🇳",goodTracks:["bahrain","spain","hungary"],   badTracks:["monaco","italy","brazil"],     style:"smooth",   rivals:["f2_bearman","f2_maloney"]},
  {id:"f2_martins",   name:"Victor Martins",    abbr:"MAR",num:6, teamId:"art",         pace:79,consistency:80,wet:77,overtaking:78,defense:79,experience:66,mental:7, flag:"🇫🇷",goodTracks:["spain","austria","bahrain"],   badTracks:["monaco","brazil","japan"],     style:"technical",rivals:[]},
  {id:"f2_hauger",    name:"Dennis Hauger",     abbr:"HAU",num:7, teamId:"virtuosi",    pace:80,consistency:78,wet:76,overtaking:80,defense:75,experience:62,mental:7, flag:"🇳🇴",goodTracks:["austria","italy","spain"],     badTracks:["monaco","singapore","hungary"],style:"aggressive",rivals:["f2_maloney"]},
  {id:"f2_doohan",    name:"Jack Doohan",       abbr:"DOO",num:8, teamId:"virtuosi",    pace:83,consistency:81,wet:80,overtaking:82,defense:80,experience:65,mental:7, flag:"🇦🇺",goodTracks:["australia","austria","bahrain"],badTracks:["monaco","singapore","japan"],  style:"charger",  rivals:["f2_bearman"]},
  {id:"f2_crawford",  name:"Jak Crawford",      abbr:"CRA",num:9, teamId:"carlin",      pace:82,consistency:80,wet:78,overtaking:82,defense:78,experience:65,mental:7, flag:"🇺🇸",goodTracks:["usa","austria","bahrain"],     badTracks:["monaco","singapore","hungary"],style:"aggressive",rivals:["f2_hauger"]},
  {id:"f2_stanek",    name:"Roman Staněk",      abbr:"STA",num:10,teamId:"carlin",      pace:77,consistency:75,wet:74,overtaking:76,defense:74,experience:56,mental:6, flag:"🇨🇿",goodTracks:["austria","hungary","bahrain"],  badTracks:["monaco","singapore","italy"],  style:"technical",rivals:[]},
  {id:"f2_ushijima",  name:"Reece Ushijima",    abbr:"USH",num:11,teamId:"hitech",      pace:76,consistency:74,wet:73,overtaking:75,defense:73,experience:50,mental:6, flag:"🇯🇵",goodTracks:["japan","bahrain","spain"],     badTracks:["monaco","brazil","usa"],       style:"technical",rivals:[]},
  {id:"f2_malvestiti",name:"Federico Malvestiti",abbr:"FED",num:12,teamId:"hitech",     pace:74,consistency:73,wet:71,overtaking:73,defense:72,experience:48,mental:6, flag:"🇮🇹",goodTracks:["italy","spain","bahrain"],    badTracks:["monaco","singapore","brazil"], style:"smooth",   rivals:[]},
  {id:"f2_bortoleto", name:"Gabriel Bortoleto", abbr:"GBR",num:13,teamId:"mp",          pace:84,consistency:82,wet:80,overtaking:84,defense:79,experience:67,mental:7, flag:"🇧🇷",goodTracks:["brazil","spain","austria"],   badTracks:["monaco","singapore","azerbaijan"],style:"charger", rivals:["f2_doohan","f2_crawford"]},
  {id:"f2_montoya",   name:"Sebastian Montoya", abbr:"MON",num:14,teamId:"mp",          pace:78,consistency:76,wet:75,overtaking:77,defense:75,experience:58,mental:7, flag:"🇨🇴",goodTracks:["spain","monaco","brazil"],    badTracks:["italy","singapore","japan"],   style:"smooth",   rivals:[]},
  {id:"f2_novalak",   name:"Clément Novalak",   abbr:"NOV",num:15,teamId:"invicta",     pace:76,consistency:78,wet:76,overtaking:74,defense:77,experience:70,mental:7, flag:"🇫🇷",goodTracks:["spain","hungary","bahrain"],  badTracks:["monaco","singapore","brazil"], style:"ironman",  rivals:[]},
  {id:"f2_armstrong", name:"Marcus Armstrong",  abbr:"ARM",num:16,teamId:"invicta",     pace:79,consistency:77,wet:76,overtaking:78,defense:76,experience:68,mental:7, flag:"🇳🇿",goodTracks:["bahrain","spain","austria"],  badTracks:["monaco","singapore","italy"],  style:"defender", rivals:["f2_novalak"]},
  {id:"f2_bedrin",    name:"Nikita Bedrin",      abbr:"BED",num:17,teamId:"vamersfoort", pace:72,consistency:71,wet:70,overtaking:71,defense:70,experience:50,mental:6, flag:"🇷🇺",goodTracks:["bahrain","spain","austria"],  badTracks:["monaco","brazil","japan"],     style:"qualifier",rivals:[]},
  {id:"f2_vesti",     name:"Frederik Vesti",     abbr:"VES",num:18,teamId:"vamersfoort", pace:78,consistency:80,wet:79,overtaking:76,defense:79,experience:66,mental:7, flag:"🇩🇰",goodTracks:["austria","hungary","spain"],  badTracks:["monaco","singapore","brazil"], style:"smooth",   rivals:[]},
  {id:"f2_boschung",  name:"Ralph Boschung",     abbr:"BOS",num:19,teamId:"trident",     pace:74,consistency:73,wet:72,overtaking:73,defense:72,experience:60,mental:6, flag:"🇨🇭",goodTracks:["austria","spain","bahrain"],  badTracks:["monaco","singapore","italy"],  style:"defender", rivals:[]},
  {id:"f2_pourchaire",name:"Théo Pourchaire",    abbr:"POU",num:20,teamId:"trident",     pace:80,consistency:82,wet:81,overtaking:78,defense:80,experience:72,mental:8, flag:"🇫🇷",goodTracks:["spain","hungary","bahrain"],  badTracks:["monaco","brazil","japan"],     style:"ironman",  rivals:["f2_maloney","f2_doohan"]},
];

// F2 runs at a subset of F1 venues — 14 rounds
const F2_TRACKS = [
  "bahrain","saudi","australia","japan","spain","monaco",
  "austria","britain","hungary","netherlands","italy","azerbaijan","singapore","abudhabi"
].map(id=>TRACKS.find(t=>t.id===id)).filter(Boolean);

// ===================== F2 COMPONENTS =====================

// ===================== F2 SIMULATION ENGINE =====================

const F2_PTS_FEATURE = [25,18,15,12,10,8,6,4,2,1];
const F2_PTS_SPRINT  = [10,8,6,5,4,3,2,1];
const F2_FAIL = ["engine failure","hydraulics failure","gearbox failure","suspension damage","brake failure","fuel pressure loss","oil leak","MGU fault"];

function calcF2Base(d, team, track) {
  const sm=getStyleMods(d);
  const ep=d.pace+sm.pace, ec=d.consistency+sm.consistency;
  const eo=d.overtaking+sm.overtaking, ex=d.experience+sm.experience;
  const ts=getF2TeamStats(team);
  // F2 spec chassis: team setup contributes ~30%, driver ~70%
  let s=ts.carPace*0.30+ep*0.70;
  if(track.type==="high-speed"||track.type==="low-downforce") s+=ep*0.05;
  else if(track.type==="technical"){s+=ec*0.06;if(d.style==="technical")s+=3;}
  else if(track.type==="street"){s+=ex*0.025+(d.defense||75)*0.015;if(d.style==="defender")s+=2;}
  if(ts.aeroCircuitBonus&&track.type&&ts.aeroCircuitBonus[track.type]) s+=ts.aeroCircuitBonus[track.type]*0.35;
  if((track.alt||0)>500) s-=((track.alt-500)/2000)*((100-ex)*0.04);
  if(track.night) s+=ex*0.02;
  if(track.street) s+=ex*0.018;
  if((track.abrasive||3)>5) s-=((track.abrasive-5)*0.3)*((100-ec)/40);
  if((track.drs||2)>=3) s+=eo*0.01;
  if((d.goodTracks||[]).includes(track.id)) s+=5;
  if((d.badTracks||[]).includes(track.id)) s-=5;
  s+=((d.mental||7)-5)*0.4;
  return s;
}
function calcF2QualBase(d,team,track){
  const sm=getStyleMods(d);
  return calcF2Base(d,team,track)+(sm.qualBonus||0)*0.65;
}

// F2 Qualifying — single 30-min session, all 20 drivers, top-10 reversed for sprint
function runF2Qual(drivers,teams,track){
  const form={};
  drivers.forEach(d=>{form[d.id]=(Math.random()-0.5)*2*7;});
  const positions=drivers.map(d=>{
    const team=teams.find(t=>t.id===d.teamId)||teams[teams.length-1];
    const score=calcF2QualBase(d,team,track)+form[d.id]+1.5*(0.7+Math.random()*0.6)+(Math.random()-0.5)*2*4;
    return {driver:d,team,score};
  }).sort((a,b)=>b.score-a.score).map((e,i)=>({...e,pos:i+1}));
  const featureGrid=[...positions];
  const top10=[...positions.slice(0,10)].reverse();
  const sprintGrid=[...top10,...positions.slice(10)];
  const events=genF2QualEvents(positions,track);
  return {positions,featureGrid,sprintGrid,events};
}

function aggF2Qual(n,drivers,teams,track){
  if(n<=1) return runF2Qual(drivers,teams,track);
  const scoreAcc={};
  drivers.forEach(d=>{scoreAcc[d.id]=[];});
  let displayRun=null;
  for(let i=0;i<n;i++){
    const q=runF2Qual(drivers,teams,track);
    if(i===Math.floor(n/2)) displayRun=q;
    q.positions.forEach(e=>scoreAcc[e.driver.id].push(e.score));
  }
  const avg=arr=>arr.length?arr.reduce((a,b)=>a+b,0)/arr.length:0;
  const positions=drivers.map(d=>{
    const team=teams.find(t=>t.id===d.teamId)||teams[teams.length-1];
    return {driver:d,team,score:avg(scoreAcc[d.id])};
  }).sort((a,b)=>b.score-a.score).map((e,i)=>({...e,pos:i+1}));
  const featureGrid=[...positions];
  const sprintGrid=[...[...positions.slice(0,10)].reverse(),...positions.slice(10)];
  const events=displayRun?displayRun.events:genF2QualEvents(positions,track);
  return {positions,featureGrid,sprintGrid,events,runsUsed:n};
}

function genF2QualEvents(positions,track){
  const evts=[];
  const fast=positions[0],second=positions[1];
  const gap=second?((fast.score-second.score)*0.011).toFixed(3):"0.000";
  const SECTORS=["the first chicane","Turn "+Math.ceil((track.corners||16)/3),"the hairpin","the final complex","a high-speed sweeper"];
  if(Math.random()<0.45){
    const victim=_pick(positions.slice(4,18));
    evts.push({type:"yellow",icon:"🟡",text:`⚠️ YELLOW FLAG — ${victim.driver.name} (${victim.team.name}) loses the car at ${_pick(SECTORS)}. Session briefly neutralised — ${_pick(["several runners on hot laps have to abort","the session restarts with 6 minutes remaining","timing screens frozen; frustration in several garages"])}.`});
  }
  if(Math.random()<0.25){
    const m=_pick(positions.slice(3,17));
    evts.push({type:"mechanical",icon:"🔧",text:`🔧 ${m.driver.name} (${m.team.name}) reports a ${_pick(["brake issue","hydraulics warning","DRS fault","gearbox hesitation","water temperature alarm"])} over the radio and aborts the session. Time is running out for the mechanics.`});
  }
  evts.push({type:"pole",icon:"🏁",text:`${fast.driver.name} takes F2 pole at ${track.circuit}. ${gap}s over ${second?.driver.name||"P2"} in a single-session format where every tenth counts. Sprint grid: top-10 REVERSED, so ${positions[9]?.driver.name||"P10"} starts the sprint from pole position.`});
  if(positions[9]){
    evts.push({type:"info",icon:"🔄",text:`REVERSED GRID: ${positions[9].driver.name} (P10 in qualifying) starts the Sprint from pole. ${fast.driver.name} — fastest qualifier — drops to P10 and must fight through the field in ${track.laps?Math.round(track.laps*0.45):22} laps. F2 at its most dramatic.`});
  }
  return evts;
}

// F2 FP (45-min session)
function runF2FP(drivers,teams,track){
  const form={};
  drivers.forEach(d=>{form[d.id]=(Math.random()-0.5)*2*11;});
  const raw=drivers.map(d=>{
    const team=teams.find(t=>t.id===d.teamId)||teams[teams.length-1];
    const score=calcF2Base(d,team,track)+form[d.id]+(Math.random()-0.5)*2*6-(Math.random()*3+1);
    const laps=Math.floor(Math.random()*10+15);
    return {driver:d,team,score,laps};
  }).sort((a,b)=>b.score-a.score);
  const best=raw[0]?.score||0;
  return raw.map((e,i)=>({...e,pos:i+1,gap:i===0?null:((best-e.score)*0.011).toFixed(3)}));
}

// F2 Testing (3 days × 2 sessions)
function runF2Testing(drivers,teams,track){
  const form={};
  drivers.forEach(d=>{form[d.id]=(Math.random()-0.5)*2*15;});
  const raw=drivers.map(d=>{
    const team=teams.find(t=>t.id===d.teamId)||teams[teams.length-1];
    const score=calcF2Base(d,team,track)+form[d.id]+(Math.random()-0.5)*2*9;
    const laps=Math.floor(Math.random()*28+30);
    return {driver:d,team,score,laps};
  }).sort((a,b)=>b.score-a.score);
  const best=raw[0]?.score||0;
  return raw.map((e,i)=>({...e,pos:i+1,gap:i===0?null:((best-e.score)*0.011).toFixed(3)}));
}

// F2 Sprint race (~21 laps, no pit stops, reverse-top-10 grid)
function runF2Sprint(grid,teams,track){
  const laps=Math.max(16,track.lapLen?Math.round(105/track.lapLen):22);
  const isWet=Math.random()*100<track.wr;
  const hasSC=Math.random()<0.42;
  const scLap=hasSC?Math.floor(Math.random()*Math.max(1,laps-4))+2:0;
  const entries=grid.map((e,gp)=>{
    const {driver:d,team}=e;
    const ts=getF2TeamStats(team);
    const sm=getStyleMods(d);
    let pace=isWet?ts.carPace*0.22+d.pace*0.18+d.wet*0.60+(ts.wetBonus||0)*0.3:ts.carPace*0.28+d.pace*0.42+d.consistency*0.30;
    pace-=gp*0.09*(track.od/100);
    if(d.style==="charger"&&gp>8) pace+=4;
    if(d.style==="aggressive"&&gp>5) pace+=2.5;
    pace+=sm.pace*0.4+sm.consistency*0.3;
    if(ts.aeroCircuitBonus?.[track.type]) pace+=ts.aeroCircuitBonus[track.type]*0.3;
    if(hasSC&&(d.style==="aggressive"||d.style==="charger")) pace+=1.5;
    pace+=(Math.random()-0.5)*7;
    const dnfRisk=Math.max(0.01,0.045+(sm.dnfRisk||0)+(d.style==="aggressive"?0.025:0));
    const dnf=Math.random()<dnfRisk;
    return {driver:d,team,gridPos:gp+1,pace,dnf,dnfLap:dnf?Math.floor(Math.random()*laps)+1:null};
  });
  const finished=entries.filter(e=>!e.dnf).sort((a,b)=>b.pace-a.pace);
  const dnfs=entries.filter(e=>e.dnf);
  const all=[...finished,...dnfs];
  let cg=0;
  all.forEach((e,i)=>{
    e.finalPos=i+1;
    e.points=(!e.dnf&&i<8)?F2_PTS_SPRINT[i]:0;
    if(i===0)e.gap=0; else if(e.dnf)e.gap=null; else{cg=parseFloat((cg+Math.random()*1.5+0.2).toFixed(3));e.gap=cg;}
  });
  return {positions:all,events:genF2RaceEvents(all,laps,track,isWet,hasSC,scLap,"sprint"),isWet,hasSC,scLap,totalLaps:laps};
}

function aggF2Sprint(n,grid,teams,track){
  if(n<=1) return runF2Sprint(grid,teams,track);
  const posAcc={},dnfCount={},dnfLaps={};
  let repRace=null,wetCnt=0,scCnt=0,scLapSum=0;
  grid.forEach(({driver})=>{posAcc[driver.id]=[];dnfCount[driver.id]=0;dnfLaps[driver.id]=[];});
  for(let i=0;i<n;i++){
    const r=runF2Sprint(grid,teams,track);
    if(i===Math.floor(n/2)) repRace=r;
    if(r.isWet) wetCnt++;
    if(r.hasSC){scCnt++;scLapSum+=r.scLap;}
    r.positions.forEach((e,idx)=>{posAcc[e.driver.id].push(idx+1);if(e.dnf){dnfCount[e.driver.id]++;if(e.dnfLap)dnfLaps[e.driver.id].push(e.dnfLap);}});
  }
  const avg=arr=>arr.length?arr.reduce((a,b)=>a+b,0)/arr.length:0;
  const canon=grid.map(({driver,team})=>{
    const dnfR=dnfCount[driver.id]/n;
    const isDNF=dnfR>=0.5;
    const ap=avg(posAcc[driver.id]);
    return {driver,team,gridPos:grid.findIndex(e=>e.driver.id===driver.id)+1,avgPos:ap,isDNF,dnfLap:isDNF&&dnfLaps[driver.id].length?Math.round(avg(dnfLaps[driver.id])):null,dnfRate:dnfR};
  }).sort((a,b)=>a.isDNF!==b.isDNF?(a.isDNF?1:-1):a.avgPos-b.avgPos);
  let cg=0;
  canon.forEach((e,i)=>{e.finalPos=i+1;e.dnf=e.isDNF;e.points=(!e.isDNF&&i<8)?F2_PTS_SPRINT[i]:0;if(i===0)e.gap=0;else if(e.isDNF)e.gap=null;else{cg=parseFloat((cg+Math.max(0.2,(e.avgPos-canon[0].avgPos)*0.9)).toFixed(3));e.gap=cg;}});
  return {positions:canon,events:repRace?.events||[],isWet:wetCnt>=n/2,hasSC:scCnt>=n/2,scLap:scCnt?Math.round(scLapSum/scCnt):0,totalLaps:repRace?.totalLaps||22,runsUsed:n};
}

// F2 Feature race (~42 laps, mandatory pit stop, Option+Prime compounds)
function runF2Feature(grid,teams,track){
  const laps=Math.max(30,track.lapLen?Math.round(190/track.lapLen):42);
  const isWet=Math.random()*100<track.wr;
  const hasSC=Math.random()<0.50;
  const scLap=hasSC?Math.floor(Math.random()*Math.max(1,laps-8))+4:0;
  const vsc=!hasSC&&Math.random()<0.28;
  const vscLap=vsc?Math.floor(Math.random()*Math.max(1,laps-8))+5:0;
  const STRATS=["Option→Prime","Option→Prime","Option→Prime","Prime→Option","Prime→Option"];
  const entries=grid.map((e,gp)=>{
    const {driver:d,team}=e;
    const ts=getF2TeamStats(team);
    const sm=getStyleMods(d);
    const strategy=TEAM_STRATEGIES.find(s=>s.id===team.strategy)||TEAM_STRATEGIES[0];
    const stMods=strategy.mods||{};
    let pace=isWet?ts.carPace*0.22+d.pace*0.18+d.wet*0.60+(ts.wetBonus||0)*0.28:ts.carPace*0.28+d.pace*0.36+d.consistency*0.36;
    const tyreStrat=_pick(STRATS);
    const onOpt=tyreStrat.startsWith("Option");
    const pitLap=isWet?0:hasSC&&scLap>8?scLap-1:Math.floor(laps*(onOpt?0.37:0.55))+(Math.floor(Math.random()*6)-3);
    if(onOpt) pace+=2.5;
    pace*=(stMods.overallPace||1.0);
    if(hasSC&&stMods.scBonus) pace*=(stMods.scBonus*0.25+0.75);
    if(stMods.lateBoost) pace+=(stMods.lateBoost-1)*5;
    pace+=sm.pace*0.4+sm.consistency*0.3+sm.racePace*0.2;
    if(ts.aeroCircuitBonus?.[track.type]) pace+=ts.aeroCircuitBonus[track.type]*0.3;
    pace-=gp*0.055*(track.od/100);
    if(d.style==="charger"&&gp>10) pace+=3;
    if(d.style==="strategist") pace+=1.5;
    pace-=(100-(ts.tyreLife||60))/100*2.5;
    pace+=(Math.random()-0.5)*7;
    const dnfRisk=Math.max(0.01,0.055+(sm.dnfRisk||0)+(stMods.dnfRisk||0));
    const dnf=Math.random()<dnfRisk;
    return {driver:d,team,gridPos:gp+1,pace,dnf,dnfLap:dnf?Math.floor(Math.random()*laps)+1:null,tyreStrat,pitLap};
  });
  const finished=entries.filter(e=>!e.dnf).sort((a,b)=>b.pace-a.pace);
  const dnfs=entries.filter(e=>e.dnf);
  const all=[...finished,...dnfs];
  let cg=0;
  all.forEach((e,i)=>{
    e.finalPos=i+1;
    e.points=(!e.dnf&&i<10)?F2_PTS_FEATURE[i]:0;
    if(i===0)e.gap=0; else if(e.dnf)e.gap=null; else{cg=parseFloat((cg+Math.random()*2.3+0.4).toFixed(3));e.gap=cg;}
  });
  const fastestLap=!isWet&&finished.length?_pick(finished.slice(0,Math.min(8,finished.length)))?.driver:null;
  if(fastestLap){const fe=all.find(e=>e.driver.id===fastestLap.id);if(fe&&!fe.dnf&&fe.finalPos<=10)fe.points+=1;}
  return {positions:all,events:genF2RaceEvents(all,laps,track,isWet,hasSC,scLap,"feature",vsc,vscLap),isWet,hasSC,scLap,vsc,vscLap,totalLaps:laps,fastestLap,fastestLapName:fastestLap?.name};
}

function aggF2Feature(n,grid,teams,track){
  if(n<=1) return runF2Feature(grid,teams,track);
  const posAcc={},dnfCount={},dnfLaps={},flCount={};
  let repRace=null,wetCnt=0,scCnt=0,scLapSum=0;
  grid.forEach(({driver})=>{posAcc[driver.id]=[];dnfCount[driver.id]=0;dnfLaps[driver.id]=[];});
  for(let i=0;i<n;i++){
    const r=runF2Feature(grid,teams,track);
    if(i===Math.floor(n/2)) repRace=r;
    if(r.isWet) wetCnt++;
    if(r.hasSC){scCnt++;scLapSum+=r.scLap;}
    if(r.fastestLap) flCount[r.fastestLap.id]=(flCount[r.fastestLap.id]||0)+1;
    r.positions.forEach((e,idx)=>{posAcc[e.driver.id].push(idx+1);if(e.dnf){dnfCount[e.driver.id]++;if(e.dnfLap)dnfLaps[e.driver.id].push(e.dnfLap);}});
  }
  const avg=arr=>arr.length?arr.reduce((a,b)=>a+b,0)/arr.length:0;
  const canon=grid.map(({driver,team})=>{
    const dnfR=dnfCount[driver.id]/n;
    const isDNF=dnfR>=0.5;
    const ap=avg(posAcc[driver.id]);
    return {driver,team,gridPos:grid.findIndex(e=>e.driver.id===driver.id)+1,avgPos:ap,isDNF,dnfLap:isDNF&&dnfLaps[driver.id].length?Math.round(avg(dnfLaps[driver.id])):null};
  }).sort((a,b)=>a.isDNF!==b.isDNF?(a.isDNF?1:-1):a.avgPos-b.avgPos);
  let cg=0;
  canon.forEach((e,i)=>{e.finalPos=i+1;e.dnf=e.isDNF;e.points=(!e.isDNF&&i<10)?F2_PTS_FEATURE[i]:0;if(i===0)e.gap=0;else if(e.isDNF)e.gap=null;else{cg=parseFloat((cg+Math.max(0.3,(e.avgPos-canon[0].avgPos)*0.9)).toFixed(3));e.gap=cg;}});
  const flId=Object.entries(flCount).sort((a,b)=>b[1]-a[1])[0]?.[0];
  const fastestLap=flId?grid.find(e=>e.driver.id===flId)?.driver:null;
  if(fastestLap){const fe=canon.find(e=>e.driver.id===fastestLap.id);if(fe&&!fe.dnf&&fe.finalPos<=10)fe.points+=1;}
  return {positions:canon,events:repRace?.events||[],isWet:wetCnt>=n/2,hasSC:scCnt>=n/2,scLap:scCnt?Math.round(scLapSum/scCnt):0,totalLaps:repRace?.totalLaps||42,fastestLap,fastestLapName:fastestLap?.name,runsUsed:n};
}

function genF2RaceEvents(entries,laps,track,isWet,hasSC,scLap,type,vsc=false,vscLap=0){
  const evts=[];
  const leader=entries[0];
  if(!leader) return evts;
  // Start
  if(Math.random()<(track.street?0.52:0.4)){
    const victim=_pick(entries.slice(2,12));
    evts.push({lap:1,type:"start",icon:"🚦",text:`FIRST LAP INCIDENT — ${victim.driver.name} (${victim.team.name}) ${_pick(["gets squeezed into the barrier at Turn 1","has contact with a rival and loses several places","locks up and runs wide over the kerbs","is spun around in a first-corner collision"])}. ${track.street?"The barriers are unforgiving here.":"Safety Car potential."}`});
  }
  // Weather
  if(isWet) evts.push({lap:1,type:"weather",icon:"🌧️",text:`RAIN at ${track.circuit}. Intermediates mandatory — drivers reporting very low grip through ${_pick(["the first sector","the hairpin area","the high-speed complex"])}. Wet weather specialists will thrive here.`});
  // Safety Car
  if(hasSC){
    const cause=_pick(entries.slice(Math.floor(entries.length/3))).driver;
    evts.push({lap:scLap,type:"safetycar",icon:"🚗",text:`SAFETY CAR — Lap ${scLap}. ${cause.name} is stopped with ${_pick(F2_FAIL)}. The field bunches up — ${type==="feature"?"pit window opens for teams yet to stop. Crucial decision time on the pitwall":"sprint restarts in 2 laps with everything to play for"}. ${_pick(["This defines the race.","Every team reacting differently.","The Safety Car periods are where F2 races are won and lost."])}`});
  }
  if(vsc&&type==="feature") evts.push({lap:vscLap,type:"safetycar",icon:"🟡",text:`VIRTUAL SAFETY CAR — Lap ${vscLap}. Debris on track. Teams with open pit windows react immediately — a free stop under VSC is the dream scenario for any strategist.`});
  // Battle for lead
  if(entries.length>=2&&Math.random()<0.65){
    const d2=entries[1];
    evts.push({lap:Math.floor(laps*0.4),type:"battle",icon:"⚔️",text:`${leader.driver.name} vs ${d2.driver.name} — wheel-to-wheel at ${track.circuit}. ${_pick(["DRS closes the gap every straight.","Side by side through the braking zone.","The crowd on their feet.","This is the F2 rivalry that has defined the season so far."])}`});
  }
  // DNF drama
  entries.filter(e=>e.dnf).slice(0,2).forEach(e=>{
    evts.push({lap:e.dnfLap||Math.floor(laps*0.5),type:"dnf",icon:"❌",text:`RETIREMENT — ${e.driver.name} (${e.team.name}) stops on Lap ${e.dnfLap||"?"} with ${_pick(F2_FAIL)}. ${_pick(["Huge blow to championship hopes.","The team review it overnight.","Mechanical failure at the worst possible moment.","Championship points gone."])}`});
  });
  // Pit stop story (feature)
  if(type==="feature"&&!isWet){
    const pitters=entries.filter(e=>!e.dnf&&e.pitLap>0).slice(0,2);
    pitters.forEach(e=>{
      evts.push({lap:e.pitLap,type:"pitstop",icon:"🔧",text:`PIT STOP — ${e.driver.name} (${e.team.name}) boxes on Lap ${e.pitLap} switching ${e.tyreStrat||"compounds"}. ${_pick(["Clean stop.","Crew needs to improve on that.","Fast pit — track position maintained.","They come out just behind their rival — the race is back on."])}`});
    });
  }
  // Charge through field
  const chargers=entries.filter(e=>!e.dnf&&e.gridPos>e.finalPos+4);
  if(chargers.length){
    const ch=chargers[0];
    evts.push({lap:Math.floor(laps*0.6),type:"charge",icon:"🚀",text:`${ch.driver.name} is FLYING — started P${ch.gridPos}, now running P${ch.finalPos}. ${_pick(["Fastest sector times in the field.","Using DRS to full effect on every straight.","The ${ch.team.name} setup is working perfectly on race tyres.","A masterclass in racecraft."])}`});
  }
  // Fastest lap
  if(type==="feature"&&!isWet){
    const flDriver=_pick(entries.filter(e=>!e.dnf&&e.finalPos<=10));
    if(flDriver) evts.push({lap:laps-2,type:"fastestlap",icon:"💜",text:`FASTEST LAP — ${flDriver.driver.name} (${flDriver.team.name}) sets the fastest lap of the race on Lap ${laps-2}. ${flDriver.finalPos<=10?"The bonus championship point is theirs.":"Just outside the top-10 — the fastest lap point goes unclaimed."}`});
  }
  // Race conclusion
  evts.push({lap:laps,type:"start",icon:"🏁",text:`${type==="feature"?"FEATURE RACE":"SPRINT RACE"} ENDS — ${leader.driver.name} (${leader.team.name}) wins at ${track.circuit}! ${entries[1]&&!entries[1].dnf?`${entries[1].driver.name} P2.`:""} ${entries[2]&&!entries[2].dnf?`${entries[2].driver.name} P3.`:""}`});
  return evts.sort((a,b)=>(a.lap||0)-(b.lap||0));
}

function F2EditModal({type,data,teams,drivers,onSave,onClose}){
  const [f,setF]=useState({...data,goodTracks:data.goodTracks||[],badTracks:data.badTracks||[],mental:data.mental||7,rivals:data.rivals||[]});
  const isD=type==="driver";
  const inp={background:"#1E1E22",border:"1px solid #333",color:"#F0F0F0",padding:"9px 12px",width:"100%",fontFamily:"inherit",fontSize:16,borderRadius:3};
  const F2C="#0067FF";

  const F2_SLOT_LABELS=[
    ["engineMapping","⚡ ENGINE MAPPING",  "engineMapping"],
    ["aeroSetup",    "🏎 AERO SETUP",      "aeroSetup"],
    ["suspensionTune","🔧 SUSPENSION TUNE","suspensionTune"],
    ["differential", "⚙️ DIFFERENTIAL",   "differential"],
    ["brakeConfig",  "🛑 BRAKE CONFIG",    "brakeConfig"],
  ];

  return(
    <div onClick={e=>e.target===e.currentTarget&&onClose()} style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.9)",zIndex:9999,display:"flex",alignItems:"center",justifyContent:"center"}}>
      <div style={{background:"#0C0C18",border:`1px solid ${F2C}33`,borderRadius:8,padding:24,width:480,maxHeight:"88vh",overflowY:"auto"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:18}}>
          <span style={{fontSize:16,fontWeight:700,letterSpacing:2.5,color:F2C}}>{isD?"EDIT F2 DRIVER":"EDIT F2 TEAM"}</span>
          <button onClick={onClose} style={{background:"none",border:"none",color:"#aaa",cursor:"pointer",fontSize:26}}>×</button>
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
                <select value={f.teamId} onChange={e=>setF(p=>({...p,teamId:e.target.value}))} style={{...inp,background:"#1E1E22"}}>{teams.map(t=><option key={t.id} value={t.id}>{t.name}</option>)}</select>
              </div>
            </div>
            {/* Driving style */}
            <div style={{marginBottom:16,padding:"12px 14px",background:"#111120",borderRadius:5,border:"1px solid #1E1E30"}}>
              <div style={{fontSize:11,color:"#aaa",letterSpacing:1.5,marginBottom:10,fontWeight:700}}>DRIVING STYLE</div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6}}>
                {DRIVING_STYLES.map(s=>{const sel=f.style===s.id;return(
                  <button key={s.id} type="button" onClick={()=>setF(p=>({...p,style:s.id}))}
                    style={{background:sel?`${s.color}1A`:"#161625",border:`1px solid ${sel?s.color+"88":"#2A2A40"}`,borderRadius:4,padding:"9px 10px",cursor:"pointer",textAlign:"left",transition:"all 0.15s"}}>
                    <div style={{display:"flex",alignItems:"center",gap:7,marginBottom:4}}>
                      <span style={{fontSize:14}}>{s.icon}</span>
                      <span style={{fontSize:12,fontWeight:700,color:sel?s.color:"#ccc",letterSpacing:1}}>{s.name.toUpperCase()}</span>
                    </div>
                    <div style={{fontSize:10,color:sel?"#aaa":"#555",lineHeight:1.45}}>{s.effects}</div>
                  </button>
                );})}
              </div>
            </div>
            {/* Mental state */}
            <div style={{marginBottom:14}}>
              <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
                <span style={{fontSize:14,color:"#aaa",letterSpacing:1.5}}>MENTAL STATE</span>
                <span style={{fontSize:16,fontWeight:700,color:f.mental>=8?"#44CC88":f.mental>=6?"#FFC906":"#FF4444",fontFamily:"monospace"}}>{f.mental}/10</span>
              </div>
              <input type="range" min={1} max={10} step={1} value={f.mental} onChange={e=>setF(p=>({...p,mental:parseInt(e.target.value)}))} style={{width:"100%",accentColor:F2C}}/>
              <div style={{fontSize:12,color:"#778",marginTop:2}}>1=Struggling · 5=Neutral · 10=Peak Focus</div>
            </div>
            {/* Track preferences */}
            <div style={{marginBottom:14,padding:"10px 12px",background:"#111120",borderRadius:4,border:"1px solid #1E1E30"}}>
              <TrackPicker goodTracks={f.goodTracks} badTracks={f.badTracks} onChange={({goodTracks,badTracks})=>setF(p=>({...p,goodTracks,badTracks}))}/>
            </div>
            {/* Rivals */}
            <div style={{marginBottom:14,padding:"12px 14px",background:"#111120",borderRadius:4,border:"1px solid #1E1E30"}}>
              <div style={{fontSize:11,color:F2C,fontWeight:700,letterSpacing:1.5,marginBottom:8}}>⚔️ RIVALRIES</div>
              <RivalPicker rivals={f.rivals||[]} currentDriverId={f.id} allDrivers={drivers.filter(d=>d.id!==f.id)} onChange={rivals=>setF(p=>({...p,rivals}))}/>
            </div>
          </>
        ):(
          <>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:14}}>
              {[["Team Name","name","text"],["Abbreviation","abbr","text"]].map(([l,k,tp])=>(
                <div key={k}><div style={{fontSize:13,color:"#aaa",letterSpacing:1.5,marginBottom:4}}>{l.toUpperCase()}</div>
                  <input value={f[k]} type={tp} maxLength={k==="abbr"?3:undefined} onChange={e=>setF(p=>({...p,[k]:k==="abbr"?e.target.value.toUpperCase():e.target.value}))} style={inp}/>
                </div>
              ))}
              <div><div style={{fontSize:13,color:"#aaa",letterSpacing:1.5,marginBottom:4}}>TEAM COLOUR</div>
                <input type="color" value={f.color} onChange={e=>setF(p=>({...p,color:e.target.value}))} style={{width:"100%",height:36,background:"#1E1E22",border:"1px solid #333",borderRadius:3,cursor:"pointer"}}/>
              </div>
              <div><div style={{fontSize:13,color:"#aaa",letterSpacing:1.5,marginBottom:4}}>PIT SPEED</div>
                <input type="number" value={f.basePitSpeed||80} onChange={e=>setF(p=>({...p,basePitSpeed:parseInt(e.target.value)||80}))} style={inp}/>
              </div>
            </div>
            {/* Strategy */}
            <div style={{marginBottom:14,padding:"12px 14px",background:"#111120",borderRadius:5,border:"1px solid #1E1E30"}}>
              <div style={{fontSize:11,color:"#aaa",letterSpacing:1.5,marginBottom:10,fontWeight:700}}>RACE STRATEGY</div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:5}}>
                {TEAM_STRATEGIES.map(s=>{const sel=f.strategy===s.id;return(
                  <button key={s.id} type="button" onClick={()=>setF(p=>({...p,strategy:s.id}))}
                    style={{background:sel?`${s.color}1A`:"#161625",border:`1px solid ${sel?s.color+"88":"#2A2A40"}`,borderRadius:4,padding:"8px 10px",cursor:"pointer",textAlign:"left",transition:"all 0.15s"}}>
                    <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:3}}>
                      <span style={{fontSize:13}}>{s.icon}</span>
                      <span style={{fontSize:11,fontWeight:700,color:sel?s.color:"#ccc",letterSpacing:0.5}}>{s.name.toUpperCase()}</span>
                    </div>
                    <div style={{fontSize:9,color:sel?"#aaa":"#555",lineHeight:1.4}}>{s.effects}</div>
                  </button>
                );})}
              </div>
            </div>
            {/* F2 Setup Slots */}
            <div style={{marginBottom:14}}>
              <div style={{fontSize:11,color:F2C,fontWeight:700,letterSpacing:1.5,marginBottom:10}}>🔩 SETUP CONFIGURATION</div>
              {/* Stats preview */}
              {(()=>{const st=getF2TeamStats({...f,parts:f.parts||{}});return(
                <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:6,marginBottom:14,padding:"10px 12px",background:"#080812",borderRadius:5,border:`1px solid ${F2C}22`}}>
                  {[["CAR PACE",st.carPace,F2C],["RELIABILITY",st.reliability,"#44CC88"],["TYRE LIFE",st.tyreLife,"#FFC906"],["WET BONUS",st.wetBonus>0?"+"+st.wetBonus:st.wetBonus,"#4488FF"],["CORNERS",Math.round(st.cornerBonus/2),"#BB66FF"],["STRAIGHTS",Math.round(st.straightBonus/2),"#FF8844"]].map(([l,v,c])=>(
                    <div key={l} style={{textAlign:"center"}}>
                      <div style={{fontSize:16,fontWeight:900,color:c,lineHeight:1}}>{v}</div>
                      <div style={{fontSize:9,color:"#556",letterSpacing:1,marginTop:2}}>{l}</div>
                    </div>
                  ))}
                </div>
              );})()}
              {F2_SLOT_LABELS.map(([slotKey,slotLabel,partsKey])=>{
                const partsList=F2_PARTS[partsKey];
                const currentId=(f.parts||{})[slotKey];
                const current=partsList.find(p=>p.id===currentId)||partsList[0];
                return(
                  <div key={slotKey} style={{marginBottom:12,background:"#111120",borderRadius:5,border:"1px solid #1E1E30",overflow:"hidden"}}>
                    <div style={{fontSize:10,color:F2C,fontWeight:700,letterSpacing:1.5,padding:"8px 12px",background:"#080818",borderBottom:"1px solid #1E1E30"}}>
                      {slotLabel}<span style={{marginLeft:8,fontSize:10,color:"#aaa",fontWeight:400}}>{current.name}</span>
                    </div>
                    <div style={{padding:"8px 10px",display:"grid",gridTemplateColumns:"1fr 1fr",gap:5,maxHeight:220,overflowY:"auto"}}>
                      {partsList.map(part=>{
                        const sel=currentId===part.id||((!currentId)&&part===partsList[0]);
                        return(
                          <button key={part.id} type="button"
                            onClick={()=>setF(prev=>({...prev,parts:{...(prev.parts||{}),[slotKey]:part.id}}))}
                            style={{background:sel?`${F2C}18`:"#161625",border:`1px solid ${sel?F2C+"66":"#2A2A40"}`,borderRadius:4,padding:"7px 9px",cursor:"pointer",textAlign:"left",transition:"all 0.12s"}}>
                            <div style={{fontSize:11,fontWeight:700,color:sel?F2C:"#ccc",marginBottom:3,lineHeight:1.3}}>{part.name}</div>
                            {part.spec&&<div style={{fontSize:9,color:"#445",marginBottom:4,letterSpacing:0.5}}>{part.spec}</div>}
                            <div style={{display:"flex",gap:4,flexWrap:"wrap"}}>
                              {Object.entries(part).filter(([k])=>["pace","reliability","cornerSpeed","straightSpeed","tyreWear","wetPerformance","fuel","cornerExit","consistency"].includes(k)&&part[k]!==undefined&&part[k]!==0).slice(0,4).map(([k,v])=>(
                                <span key={k} style={{fontSize:8,padding:"1px 5px",borderRadius:2,background:v>0?"#44CC8818":"#E8002D18",color:v>0?"#44CC88":"#E8002D",fontWeight:700}}>
                                  {k.replace("Speed","Spd").replace("Performance","Perf").replace("cornerExit","Exit")}: {v>0?"+":""}{v}
                                </span>
                              ))}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                    {current.description&&(
                      <div style={{padding:"6px 12px 8px",fontSize:11,color:"#445",lineHeight:1.5,borderTop:"1px solid #1A1A28",fontStyle:"italic"}}>{current.description}</div>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}
        <div style={{display:"flex",gap:10,marginTop:18}}>
          <button onClick={()=>onSave(f)} style={{flex:1,background:F2C,color:"#fff",border:"none",padding:11,cursor:"pointer",fontFamily:"inherit",fontSize:16,fontWeight:700,letterSpacing:2.5,borderRadius:3}}>SAVE</button>
          <button onClick={onClose} style={{background:"transparent",color:"#aaa",border:"1px solid #333",padding:"11px 18px",cursor:"pointer",fontFamily:"inherit",fontSize:15,borderRadius:3}}>CANCEL</button>
        </div>
      </div>
    </div>
  );
}

function F2Sim({onBack}){
  const [drivers,setDrivers]=useState(()=>{try{const s=localStorage.getItem('f2sim_drivers');return s?JSON.parse(s):F2_DRIVERS;}catch{return F2_DRIVERS;}});
  const [teams,setTeams]=useState(()=>{try{const s=localStorage.getItem('f2sim_teams');return s?JSON.parse(s):F2_TEAMS;}catch{return F2_TEAMS;}});
  const [track,setTrack]=useState(F2_TRACKS[0]);
  const [view,setView]=useState("garage");
  const [gTab,setGTab]=useState("drivers");
  const [modal,setModal]=useState(null);
  const [fp,setFp]=useState(null);
  const [qual,setQual]=useState(null);
  const [sprint,setSprint]=useState(null);
  const [race,setRace]=useState(null);
  const [testing,setTesting]=useState(null);
  const [testDay,setTestDay]=useState(1);
  const [testSession,setTestSession]=useState("AM");
  const [championship,setChampionship]=useState(()=>{try{const s=localStorage.getItem('f2sim_champ');return s?JSON.parse(s):[];}catch{return [];}});
  const [f2ChampTab,setF2ChampTab]=useState("drivers");
  const [f2QTab,setF2QTab]=useState("quali");
  const [isGen,setIsGen]=useState(false);
  const [genMsg,setGenMsg]=useState("");
  const [runAccuracy,setRunAccuracy]=useState(5);
  const [raceSaved,setRaceSaved]=useState(false);

  React.useEffect(()=>{try{localStorage.setItem('f2sim_drivers',JSON.stringify(drivers));}catch(e){}},[drivers]);
  React.useEffect(()=>{try{localStorage.setItem('f2sim_teams',JSON.stringify(teams));}catch(e){}},[teams]);
  React.useEffect(()=>{try{localStorage.setItem('f2sim_champ',JSON.stringify(championship));}catch(e){}},[championship]);

  const teamDrivers=id=>drivers.filter(d=>d.teamId===id);
  const saveDriver=d=>setDrivers(prev=>prev.map(x=>x.id===d.id?d:x));
  const saveTeam=t=>setTeams(prev=>prev.some(x=>x.id===t.id)?prev.map(x=>x.id===t.id?t:x):[...prev,t]);

  // Reset sessions when track changes
  React.useEffect(()=>{setFp(null);setQual(null);setSprint(null);setRace(null);setRaceSaved(false);},[track.id]);

  const doFP=()=>{
    setIsGen(true);setGenMsg("Running free practice…");
    setTimeout(()=>{setFp(runF2FP(drivers,teams,track));setIsGen(false);setView("fp");},(200));
  };
  const doQual=()=>{
    setIsGen(true);setGenMsg("Running qualifying…");
    setTimeout(()=>{setQual(aggF2Qual(runAccuracy,drivers,teams,track));setIsGen(false);setView("qualifying");},(200));
  };
  const doSprint=()=>{
    if(!qual) return;
    setIsGen(true);setGenMsg("Running sprint race…");
    setTimeout(()=>{setSprint(aggF2Sprint(runAccuracy,qual.sprintGrid,teams,track));setIsGen(false);setView("sprint");},(200));
  };
  const doRace=()=>{
    if(!qual) return;
    setIsGen(true);setGenMsg("Running feature race…");
    setTimeout(()=>{setRace(aggF2Feature(runAccuracy,qual.featureGrid,teams,track));setIsGen(false);setView("race");},(200));
  };
  const doTesting=()=>{
    setIsGen(true);setGenMsg(`Running Day ${testDay} ${testSession} session…`);
    setTimeout(()=>{setTesting(runF2Testing(drivers,teams,_pick(F2_TRACKS)));setIsGen(false);},150);
  };
  const saveToChampionship=()=>{
    if(!qual||!race) return;
    const round={
      id:Date.now(),round:championship.length+1,
      trackName:track.name,trackFlag:track.flag,trackCircuit:track.circuit,
      trackId:track.id,
      qual:{positions:qual.positions.map(e=>({driverId:e.driver.id,driverName:e.driver.name,driverFlag:e.driver.flag,teamId:e.team.id,teamName:e.team.name,teamColor:e.team.color,pos:e.pos,score:e.score}))},
      sprint:sprint?{positions:sprint.positions.map(e=>({driverId:e.driver.id,driverName:e.driver.name,driverFlag:e.driver.flag,teamId:e.team.id,teamName:e.team.name,teamColor:e.team.color,finalPos:e.finalPos,points:e.points,dnf:e.dnf,gap:e.gap,gridPos:e.gridPos}))}:null,
      race:{positions:race.positions.map(e=>({driverId:e.driver.id,driverName:e.driver.name,driverFlag:e.driver.flag,teamId:e.team.id,teamName:e.team.name,teamColor:e.team.color,finalPos:e.finalPos,points:e.points,dnf:e.dnf,gap:e.gap,gridPos:e.gridPos,tyreStrat:e.tyreStrat})),isWet:race.isWet,hasSC:race.hasSC,fastestLapName:race.fastestLapName,totalLaps:race.totalLaps},
    };
    setChampionship(prev=>[...prev,round]);
    setRaceSaved(true);
  };

  const F2C="#0067FF";
  const sprintLocked=!qual;
  const raceLocked=!qual;
  const nb=(active,locked=false)=>({
    background:active?`${F2C}18`:"transparent",
    color:locked?"#333":active?F2C:"#667",
    border:`1px solid ${active?F2C+"44":"transparent"}`,
    borderBottom:`2px solid ${active?F2C:"transparent"}`,
    padding:"6px 14px",
    cursor:locked?"default":"pointer",
    fontFamily:"inherit",fontSize:13,fontWeight:700,letterSpacing:1.5,
    height:58,transition:"all 0.15s",whiteSpace:"nowrap",opacity:locked?0.4:1,
  });

  return(
    <ErrorBoundary>
    <div style={{background:"#080A18",minHeight:"100vh",fontFamily:"'Rajdhani','Segoe UI',sans-serif",color:"#F0F0F0"}}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Rajdhani:wght@400;500;600;700&display=swap');
        html{font-size:16px}*{box-sizing:border-box;margin:0;padding:0}
        ::-webkit-scrollbar{width:4px;height:4px}::-webkit-scrollbar-track{background:#080A18}::-webkit-scrollbar-thumb{background:#1E2040}
        .f2hov:hover{background:#111130!important}.f2hovt:hover{border-color:${F2C}44!important;background:#0C0C20!important}
        @keyframes fadeIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
      `}</style>

      {/* HEADER */}
      <div style={{background:"#0A0A1A",borderBottom:`2px solid ${F2C}`,display:"flex",alignItems:"center",height:58,paddingLeft:14,overflowX:"auto"}}>
        <div style={{fontSize:18,fontWeight:700,letterSpacing:4,color:F2C,marginRight:16,flexShrink:0}}>F2 ▶ SIM</div>
        <button onClick={()=>setView("garage")} style={nb(view==="garage")}>GARAGE</button>
        <button onClick={()=>setView("tracks")} style={nb(view==="tracks")}>TRACKS</button>
        <button onClick={()=>setView("testing")} style={nb(view==="testing")}>TESTING</button>
        <button onClick={()=>setView("fp")} style={nb(view==="fp")}>FP</button>
        <button onClick={()=>!sprintLocked&&setView("qualifying")} style={nb(view==="qualifying")} disabled={false}>QUALIFYING</button>
        <button onClick={()=>!sprintLocked&&setView("sprint")} style={nb(view==="sprint",sprintLocked)}>SPRINT</button>
        <button onClick={()=>!raceLocked&&setView("race")} style={nb(view==="race",raceLocked)}>FEATURE RACE</button>
        <button onClick={()=>setView("championship")} style={nb(view==="championship")}>🏆 CHAMPIONSHIP</button>
        <div style={{marginLeft:"auto",display:"flex",alignItems:"center",gap:8,paddingRight:14,flexShrink:0}}>
          <span style={{fontSize:11,color:"#556",letterSpacing:1,whiteSpace:"nowrap"}}>ACCURACY</span>
          {[1,5,10,20].map(n=>(
            <button key={n} onClick={()=>setRunAccuracy(n)} style={{background:runAccuracy===n?`${F2C}22`:"transparent",color:runAccuracy===n?F2C:"#556",border:`1px solid ${runAccuracy===n?F2C+"44":"#1E2040"}`,padding:"3px 8px",cursor:"pointer",fontFamily:"inherit",fontSize:11,fontWeight:700,letterSpacing:1,borderRadius:2,transition:"all 0.15s"}}>×{n}</button>
          ))}
          <div style={{width:1,height:20,background:"#1E2040"}}/>
          <button onClick={onBack}
            style={{background:"#080A1A",color:F2C,border:`1px solid ${F2C}55`,padding:"5px 14px",cursor:"pointer",fontFamily:"inherit",fontSize:12,fontWeight:700,letterSpacing:1.5,borderRadius:3,whiteSpace:"nowrap",transition:"all 0.15s"}}
            onMouseEnter={e=>{e.currentTarget.style.background=`${F2C}22`;e.currentTarget.style.borderColor=`${F2C}99`;}}
            onMouseLeave={e=>{e.currentTarget.style.background="#080A1A";e.currentTarget.style.borderColor=`${F2C}55`;}}>
            ⏏ HOME
          </button>
        </div>
      </div>

      {isGen&&(
        <div style={{position:"fixed",inset:0,background:"rgba(8,10,24,0.92)",zIndex:8000,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:16}}>
          <div style={{display:"flex",gap:8}}>{[0,1,2].map(i=><div key={i} style={{width:10,height:10,background:F2C,borderRadius:"50%",animation:"pulse 1.2s ease-in-out infinite",animationDelay:`${i*0.15}s`}}/>)}</div>
          <div style={{fontSize:16,color:F2C,fontWeight:700,letterSpacing:3}}>{genMsg}</div>
        </div>
      )}

      <div style={{padding:18,maxWidth:1120,margin:"0 auto"}}>

        {/* GARAGE VIEW */}
        {view==="garage"&&(
          <div style={{animation:"fadeIn 0.2s ease"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:16}}>
              <div>
                <div style={{fontSize:26,fontWeight:700,letterSpacing:3}}>2027 F2 GARAGE</div>
                <div style={{fontSize:14,color:"#556",letterSpacing:1.5,marginTop:2}}>{drivers.length} DRIVERS · {teams.length} TEAMS · SPEC CHASSIS · MECHACHROME ENGINE</div>
              </div>
              <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                {[["DRIVERS","drivers"],["TEAMS","teams"]].map(([l,t])=>(
                  <button key={t} onClick={()=>setGTab(t)} style={{background:gTab===t?"#1A1A30":"transparent",color:gTab===t?"#F0F0F0":"#667",border:"1px solid #1A1A30",padding:"5px 12px",cursor:"pointer",fontFamily:"inherit",fontSize:14,fontWeight:700,letterSpacing:1.5,borderRadius:3}}>{l}</button>
                ))}
                <button onClick={()=>setModal({type:"driver",data:{name:"",abbr:"",num:21,teamId:teams[0]?.id||"",pace:75,consistency:75,wet:73,overtaking:74,defense:73,experience:45,mental:7,flag:"🏁",goodTracks:[],badTracks:[],style:"balanced",rivals:[]}})}
                  style={{background:F2C,color:"#fff",border:"none",padding:"5px 12px",cursor:"pointer",fontFamily:"inherit",fontSize:14,fontWeight:700,letterSpacing:1.5,borderRadius:3}}>+ DRIVER</button>
                <button onClick={()=>setModal({type:"team",data:{name:"",abbr:"",color:"#555",tc:"#fff",basePitSpeed:78,engine:"Mechachrome",strategy:"one_stop",parts:{...F2_TEAM_DEFAULT_SETUPS.dams}}})}
                  style={{background:"#1A1A30",color:"#ccc",border:"none",padding:"5px 12px",cursor:"pointer",fontFamily:"inherit",fontSize:14,fontWeight:700,letterSpacing:1.5,borderRadius:3}}>+ TEAM</button>
              </div>
            </div>

            {/* DRIVERS TAB */}
            {gTab==="drivers"&&(
              <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(215px,1fr))",gap:10}}>
                {teams.map(team=>teamDrivers(team.id).map(d=>{
                  const goodNames=d.goodTracks?.map(id=>TRACKS.find(t=>t.id===id)?.flag||"").filter(Boolean)||[];
                  const badNames=d.badTracks?.map(id=>TRACKS.find(t=>t.id===id)?.flag||"").filter(Boolean)||[];
                  return(
                    <div key={d.id} className="f2hov" onClick={()=>setModal({type:"driver",data:d})}
                      style={{background:"#0E0E1E",border:`1px solid ${team.color}18`,borderLeft:`3px solid ${team.color}`,borderRadius:4,padding:"13px 15px",cursor:"pointer",transition:"background 0.15s"}}>
                      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:8}}>
                        <div>
                          <div style={{fontSize:13,color:"#556",letterSpacing:1.5}}>{d.flag} #{d.num}</div>
                          <div style={{fontSize:16,fontWeight:700,marginTop:1}}>{d.name}</div>
                          <div style={{fontSize:12,color:team.color,fontWeight:700,letterSpacing:1.5,marginTop:1}}>{team.name}</div>
                        </div>
                        <div style={{fontSize:20,fontWeight:900,color:team.color,opacity:0.6}}>{d.abbr}</div>
                      </div>
                      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:"6px 10px",marginBottom:8}}>
                        {[["PCE",d.pace],["CON",d.consistency],["WET",d.wet]].map(([l,v])=>(
                          <div key={l}><div style={{display:"flex",justifyContent:"space-between",fontSize:12,color:"#556",letterSpacing:1.5}}><span>{l}</span><span style={{color:"#aaa"}}>{v}</span></div><Bar val={v} color={team.color}/></div>
                        ))}
                      </div>
                      <MentalBar val={d.mental||7} color={team.color}/>
                      {(()=>{const sty=DRIVING_STYLES.find(s=>s.id===d.style);return sty?(<div style={{display:"flex",alignItems:"center",gap:5,marginTop:5,marginBottom:2}}><span style={{fontSize:12}}>{sty.icon}</span><span style={{fontSize:10,color:sty.color,fontWeight:700,letterSpacing:1}}>{sty.name.toUpperCase()}</span></div>):null;})()}
                      <div style={{display:"flex",justifyContent:"space-between",marginTop:4,fontSize:12}}>
                        <span style={{color:"#44CC88"}}>{goodNames.join(" ")||"—"}</span>
                        <span style={{color:"#FF4444"}}>{badNames.join(" ")||"—"}</span>
                      </div>
                      {(d.rivals||[]).length>0&&(
                        <div style={{marginTop:5,display:"flex",alignItems:"center",gap:4,flexWrap:"wrap"}}>
                          <span style={{fontSize:9,color:F2C,fontWeight:700,letterSpacing:1}}>⚔️</span>
                          {(d.rivals||[]).map(rid=>{const rd=drivers.find(x=>x.id===rid);return rd?<span key={rid} style={{fontSize:9,color:"#aaa",background:`${F2C}1A`,border:`1px solid ${F2C}33`,padding:"1px 5px",borderRadius:2}}>{rd.name.split(" ").pop()}</span>:null;})}
                        </div>
                      )}
                    </div>
                  );
                }))}
              </div>
            )}

            {/* TEAMS TAB */}
            {gTab==="teams"&&(
              <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(285px,1fr))",gap:12}}>
                {teams.map(t=>{
                  const st=getF2TeamStats(t);
                  return(
                    <div key={t.id} className="f2hov" onClick={()=>setModal({type:"team",data:t})}
                      style={{background:"#0E0E1E",border:`1px solid ${t.color}22`,borderTop:`3px solid ${t.color}`,borderRadius:4,padding:16,cursor:"pointer",transition:"background 0.15s"}}>
                      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:14}}>
                        <div>
                          <div style={{fontSize:20,fontWeight:700}}>{t.name}</div>
                          <div style={{fontSize:13,color:"#556",letterSpacing:1.5,marginTop:2}}>⚙️ {t.engine}</div>
                        </div>
                        <div style={{background:t.color,color:t.tc||"#fff",fontSize:14,fontWeight:700,padding:"3px 8px",letterSpacing:2.5,borderRadius:2}}>{t.abbr}</div>
                      </div>
                      {[["CAR PACE",st.carPace],["RELIABILITY",st.reliability],["PIT SPEED",st.pitSpeed]].map(([l,v])=>(
                        <div key={l} style={{marginBottom:9}}><div style={{display:"flex",justifyContent:"space-between",fontSize:13,color:"#556",letterSpacing:1.5,marginBottom:2}}><span>{l}</span><span style={{color:"#bbb"}}>{v}</span></div><Bar val={v} color={t.color}/></div>
                      ))}
                      {/* Setup configuration badges */}
                      <div style={{marginTop:10,marginBottom:8,display:"flex",flexWrap:"wrap",gap:4}}>
                        {[
                          ["⚡",st.em?.name],
                          ["🏎",st.ae?.name],
                          ["🔧",st.sus?.name],
                          ["⚙️",st.df?.name],
                          ["🛑",st.bk?.name],
                        ].map(([icon,name])=>name&&(
                          <span key={name} style={{fontSize:9,color:"#667",background:"#111120",border:"1px solid #1A1A30",padding:"2px 6px",borderRadius:2,letterSpacing:0.5}}>{icon} {name.split(" ")[0]}</span>
                        ))}
                      </div>
                      {(()=>{const strat=TEAM_STRATEGIES.find(s=>s.id===t.strategy);return strat?(
                        <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:4}}>
                          <span style={{fontSize:12}}>{strat.icon}</span>
                          <span style={{fontSize:10,color:strat.color,fontWeight:700,letterSpacing:1}}>{strat.name.toUpperCase()}</span>
                        </div>
                      ):null;})()}
                      <div style={{marginTop:4,fontSize:13,color:"#556"}}>{teamDrivers(t.id).map(d=>d.name).join(" · ")||"No drivers"}</div>
                    </div>
                  );
                })}
              </div>
            )}

            <div style={{marginTop:20,display:"flex",justifyContent:"flex-end"}}>
              <button onClick={()=>setView("tracks")} style={{background:F2C,color:"#fff",border:"none",padding:"11px 28px",cursor:"pointer",fontFamily:"inherit",fontSize:16,fontWeight:700,letterSpacing:3,borderRadius:3}}>SELECT TRACK →</button>
            </div>
          </div>
        )}

        {/* TRACKS VIEW */}
        {view==="tracks"&&(
          <div style={{animation:"fadeIn 0.2s ease"}}>
            <div style={{marginBottom:16}}>
              <div style={{fontSize:26,fontWeight:700,letterSpacing:3}}>2027 F2 CALENDAR</div>
              <div style={{fontSize:14,color:"#556",letterSpacing:1.5,marginTop:2}}>{F2_TRACKS.length} ROUNDS · SPRINT & FEATURE RACE FORMAT</div>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(225px,1fr))",gap:9}}>
              {F2_TRACKS.map((tr,idx)=>(
                <div key={tr.id} className="f2hovt" onClick={()=>setTrack(tr)}
                  style={{background:track.id===tr.id?"#0C1020":"#0E0E1E",border:`1px solid ${track.id===tr.id?F2C:"#1A1A30"}`,borderLeft:`3px solid ${track.id===tr.id?F2C:"#1A1A30"}`,borderRadius:4,padding:"13px 15px",cursor:"pointer",transition:"all 0.15s"}}>
                  <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
                    <span style={{fontSize:20}}>{tr.flag}</span>
                    <div style={{display:"flex",gap:6,alignItems:"center"}}>
                      <span style={{fontSize:11,color:"#667",background:"#111120",padding:"1px 6px",borderRadius:2,fontWeight:700}}>Rd {idx+1}</span>
                      {tr.hasSprint&&<span style={{fontSize:12,color:"#FFC906",background:"#FFC90620",padding:"1px 5px",borderRadius:2,fontWeight:700}}>⚡ SPRINT</span>}
                    </div>
                  </div>
                  <div style={{fontSize:16,fontWeight:700}}>{tr.name}</div>
                  <div style={{fontSize:13,color:"#778",marginBottom:6}}>{tr.circuit}</div>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:"4px 0",marginBottom:5}}>
                    {[["OVT",100-tr.od,F2C],["DEG",tr.td,"#FFC906"],["WET",tr.wr,"#4488FF"]].map(([l,v,c])=>(
                      <div key={l}><div style={{fontSize:11,color:"#556",letterSpacing:1.5}}>{l}</div><div style={{height:4,background:"#151525",borderRadius:1,marginTop:2}}><div style={{height:4,width:`${v}%`,background:c,borderRadius:1}}/></div></div>
                    ))}
                  </div>
                  <div style={{display:"flex",flexWrap:"wrap",gap:"3px 6px"}}>
                    {tr.drs&&<span style={{fontSize:10,color:"#556"}}>{tr.drs} DRS</span>}
                    {tr.corners&&<span style={{fontSize:10,color:"#556"}}>{tr.corners} turns</span>}
                    {tr.lapLen&&<span style={{fontSize:10,color:"#556"}}>{tr.lapLen}km</span>}
                    {(tr.alt||0)>400&&<span style={{fontSize:10,color:"#FF8844"}}>⛰{tr.alt}m</span>}
                    {tr.night&&<span style={{fontSize:10,color:"#FFC906"}}>🌙</span>}
                    {tr.street&&<span style={{fontSize:10,color:"#4488FF"}}>🏙</span>}
                    {tr.topSpeed&&<span style={{fontSize:10,color:"#556"}}>{tr.topSpeed}km/h</span>}
                  </div>
                  {track.id===tr.id&&(
                    <div style={{marginTop:8,fontSize:11,color:F2C,fontWeight:700,letterSpacing:1.5}}>▶ SELECTED</div>
                  )}
                </div>
              ))}
            </div>
            <div style={{marginTop:18,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <button onClick={()=>setView("garage")} style={{background:"transparent",color:"#667",border:"1px solid #1A1A30",padding:"11px 28px",cursor:"pointer",fontFamily:"inherit",fontSize:16,fontWeight:700,letterSpacing:3,borderRadius:3}}>← GARAGE</button>
              <div style={{display:"flex",gap:8,alignItems:"center"}}>
                <div style={{fontSize:14,color:"#556"}}>{track.name} — {track.circuit} {track.flag}</div>
                <button onClick={doFP} style={{background:"#111120",color:"#4488FF",border:"1px solid #4488FF44",padding:"10px 18px",cursor:"pointer",fontFamily:"inherit",fontSize:14,fontWeight:700,letterSpacing:2,borderRadius:3}}>▶ FP</button>
                <button onClick={doQual} style={{background:`${F2C}18`,color:F2C,border:`1px solid ${F2C}66`,padding:"10px 22px",cursor:"pointer",fontFamily:"inherit",fontSize:14,fontWeight:700,letterSpacing:2,borderRadius:3}}>▶ QUALIFYING</button>
              </div>
            </div>
          </div>
        )}

        {/* TESTING VIEW */}
        {view==="testing"&&(
          <div style={{animation:"fadeIn 0.2s ease"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:16}}>
              <div>
                <div style={{fontSize:26,fontWeight:700,letterSpacing:3}}>PRE-SEASON TESTING</div>
                <div style={{fontSize:14,color:"#556",letterSpacing:1.5,marginTop:2}}>BAHRAIN INTERNATIONAL CIRCUIT · 3 DAYS · MECHACHROME SPEC</div>
              </div>
              <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
                <div style={{display:"flex",gap:4}}>
                  {[1,2,3].map(d=><button key={d} onClick={()=>setTestDay(d)} style={{background:testDay===d?`${F2C}22`:"#111120",color:testDay===d?F2C:"#556",border:`1px solid ${testDay===d?F2C+"55":"#1A1A30"}`,padding:"5px 10px",cursor:"pointer",fontFamily:"inherit",fontSize:13,fontWeight:700,borderRadius:3}}>Day {d}</button>)}
                </div>
                <div style={{display:"flex",gap:4}}>
                  {["AM","PM"].map(s=><button key={s} onClick={()=>setTestSession(s)} style={{background:testSession===s?`${F2C}22`:"#111120",color:testSession===s?F2C:"#556",border:`1px solid ${testSession===s?F2C+"55":"#1A1A30"}`,padding:"5px 10px",cursor:"pointer",fontFamily:"inherit",fontSize:13,fontWeight:700,borderRadius:3}}>{s}</button>)}
                </div>
                <button onClick={doTesting} style={{background:F2C,color:"#fff",border:"none",padding:"6px 18px",cursor:"pointer",fontFamily:"inherit",fontSize:14,fontWeight:700,letterSpacing:2,borderRadius:3}}>▶ RUN SESSION</button>
              </div>
            </div>
            {!testing&&(
              <div style={{textAlign:"center",padding:"60px 0",color:"#334"}}>
                <div style={{fontSize:32,marginBottom:12}}>🔬</div>
                <div style={{fontSize:18,fontWeight:700,letterSpacing:2,marginBottom:8}}>NO SESSION DATA</div>
                <div style={{fontSize:14,color:"#445"}}>Select a day and session, then hit RUN SESSION to begin testing.</div>
              </div>
            )}
            {testing&&(
              <div>
                <div style={{fontSize:13,color:"#556",letterSpacing:2,marginBottom:10}}>DAY {testDay} · {testSession} SESSION · PROVISIONAL TIMES</div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6}}>
                  {testing.map((e,i)=>(
                    <div key={e.driver.id} style={{display:"flex",alignItems:"center",gap:10,padding:"10px 14px",background:"#0E0E1E",border:`1px solid ${i<3?"#1A2540":"#1A1A30"}`,borderLeft:`3px solid ${e.team.color}`,borderRadius:3}}>
                      <div style={{width:28,textAlign:"center",fontSize:13,fontWeight:700,color:i<3?"#FFC906":"#445"}}>{i+1}</div>
                      <div style={{flex:1}}>
                        <div style={{fontSize:14,fontWeight:700}}>{e.driver.flag} {e.driver.name}</div>
                        <div style={{fontSize:12,color:e.team.color,letterSpacing:1}}>{e.team.name}</div>
                      </div>
                      <div style={{textAlign:"right"}}>
                        <div style={{fontSize:13,fontFamily:"monospace",color:i===0?F2C:"#aaa"}}>{i===0?"FASTEST":`+${e.gap}s`}</div>
                        <div style={{fontSize:11,color:"#445"}}>{e.laps} laps</div>
                      </div>
                    </div>
                  ))}
                </div>
                <div style={{marginTop:12,padding:"10px 14px",background:"#0A0A18",border:`1px solid ${F2C}22`,borderRadius:4,fontSize:13,color:"#556",lineHeight:1.7}}>
                  ⚠️ Testing times are indicative only — different fuel loads, tyre compounds, and setup programmes mean the real competitive order will only emerge in qualifying.
                </div>
              </div>
            )}
          </div>
        )}

        {/* FP VIEW */}
        {view==="fp"&&(
          <div style={{animation:"fadeIn 0.2s ease"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:16}}>
              <div>
                <div style={{fontSize:26,fontWeight:700,letterSpacing:3}}>FREE PRACTICE</div>
                <div style={{fontSize:14,color:"#556",letterSpacing:1.5,marginTop:2}}>{track.flag} {track.circuit} · 45 MINUTES</div>
              </div>
              <div style={{display:"flex",gap:8}}>
                <button onClick={doFP} style={{background:"#111120",color:"#4488FF",border:"1px solid #4488FF44",padding:"6px 16px",cursor:"pointer",fontFamily:"inherit",fontSize:13,fontWeight:700,letterSpacing:1.5,borderRadius:3}}>↺ RE-RUN FP</button>
                <button onClick={doQual} style={{background:`${F2C}18`,color:F2C,border:`1px solid ${F2C}55`,padding:"6px 16px",cursor:"pointer",fontFamily:"inherit",fontSize:13,fontWeight:700,letterSpacing:1.5,borderRadius:3}}>▶ QUALIFYING →</button>
              </div>
            </div>
            {!fp&&(
              <div style={{textAlign:"center",padding:"60px 0",color:"#334"}}>
                <div style={{fontSize:32,marginBottom:12}}>🔬</div>
                <div style={{fontSize:16,fontWeight:700}}>No FP data — go to TRACKS and run FP or click RE-RUN FP above.</div>
              </div>
            )}
            {fp&&(
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6}}>
                {fp.map((e,i)=>(
                  <div key={e.driver.id} style={{display:"flex",alignItems:"center",gap:10,padding:"10px 14px",background:"#0E0E1E",border:`1px solid ${i<3?"#1A2030":"#1A1A30"}`,borderLeft:`3px solid ${e.team.color}`,borderRadius:3}}>
                    <div style={{width:28,textAlign:"center",fontSize:13,fontWeight:700,color:i<3?"#FFC906":"#445"}}>{i+1}</div>
                    <div style={{flex:1}}>
                      <div style={{fontSize:14,fontWeight:700}}>{e.driver.flag} {e.driver.name}</div>
                      <div style={{fontSize:12,color:e.team.color,letterSpacing:1}}>{e.team.name}</div>
                    </div>
                    <div style={{textAlign:"right"}}>
                      <div style={{fontSize:13,fontFamily:"monospace",color:i===0?F2C:"#aaa"}}>{i===0?"BEST":`+${e.gap}s`}</div>
                      <div style={{fontSize:11,color:"#445"}}>{e.laps} laps</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* QUALIFYING VIEW */}
        {view==="qualifying"&&(
          <div style={{animation:"fadeIn 0.2s ease"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:16}}>
              <div>
                <div style={{fontSize:26,fontWeight:700,letterSpacing:3}}>QUALIFYING</div>
                <div style={{fontSize:14,color:"#556",letterSpacing:1.5,marginTop:2}}>{track.flag} {track.circuit} · 30 MIN SINGLE SESSION · TOP-10 REVERSED FOR SPRINT{qual?.runsUsed>1?` · ×${qual.runsUsed} AVERAGED`:""}</div>
              </div>
              <div style={{display:"flex",gap:8}}>
                <button onClick={doQual} style={{background:"#111120",color:"#667",border:"1px solid #1A1A30",padding:"6px 14px",cursor:"pointer",fontFamily:"inherit",fontSize:13,fontWeight:700,borderRadius:3}}>↺ RE-RUN</button>
                <button onClick={doSprint} style={{background:`${F2C}18`,color:F2C,border:`1px solid ${F2C}55`,padding:"6px 16px",cursor:"pointer",fontFamily:"inherit",fontSize:13,fontWeight:700,borderRadius:3}}>▶ SPRINT →</button>
                <button onClick={doRace} style={{background:"#44CC8818",color:"#44CC88",border:"1px solid #44CC8855",padding:"6px 16px",cursor:"pointer",fontFamily:"inherit",fontSize:13,fontWeight:700,borderRadius:3}}>▶ FEATURE →</button>
              </div>
            </div>
            {qual&&(
              <>
                <div style={{display:"flex",gap:3,marginBottom:14,background:"#0A0A18",padding:4,borderRadius:5,border:`1px solid #1A1A30`}}>
                  {[["quali","QUALIFYING ORDER",F2C],["sprint","SPRINT GRID (REV TOP-10)","#FFC906"],["feature","FEATURE GRID","#44CC88"]].map(([k,l,c])=>(
                    <button key={k} onClick={()=>setF2QTab(k)} style={{flex:1,background:f2QTab===k?`${c}18`:"transparent",color:f2QTab===k?c:"#556",border:`1px solid ${f2QTab===k?c+"44":"transparent"}`,padding:"7px 0",cursor:"pointer",fontFamily:"inherit",fontSize:13,fontWeight:700,letterSpacing:1,borderRadius:3}}>
                      {l}
                    </button>
                  ))}
                </div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6,marginBottom:14}}>
                  {(f2QTab==="quali"?qual.positions:f2QTab==="sprint"?qual.sprintGrid:qual.featureGrid).map((e,i)=>{
                    const best=qual.positions[0].score;
                    const gapS=i===0?null:((best-e.score)*0.011).toFixed(3);
                    const noteColor=f2QTab==="sprint"?(i<10?"#FFC906":"#556"):f2QTab==="feature"?(i<10?"#44CC88":"#556"):F2C;
                    return(
                      <div key={e.driver.id} style={{display:"flex",alignItems:"center",gap:10,padding:"10px 14px",background:i<3?"#0D0D1C":"#0E0E1E",border:`1px solid ${i<3?`${noteColor}22`:"#1A1A30"}`,borderLeft:`3px solid ${e.team.color}`,borderRadius:3}}>
                        <div style={{width:28,height:28,display:"flex",alignItems:"center",justifyContent:"center",background:i===0?"#FFC906":i===1?"#aaa":i===2?"#CD7F32":"transparent",color:i<3?"#000":"#556",fontSize:12,fontWeight:700,borderRadius:2,border:i>=3?"1px solid #1A1A30":"none",flexShrink:0}}>{i+1}</div>
                        <div style={{flex:1,minWidth:0}}>
                          <div style={{fontSize:14,fontWeight:700}}>{e.driver.flag} {e.driver.name}</div>
                          <div style={{fontSize:11,color:e.team.color,letterSpacing:1}}>{e.team.name}</div>
                        </div>
                        <div style={{textAlign:"right",flexShrink:0}}>
                          <div style={{fontSize:12,fontFamily:"monospace",color:i===0?noteColor:"#aaa"}}>{i===0?(f2QTab==="quali"?"POLE":"P1"):gapS?`+${gapS}s`:""}</div>
                        </div>
                      </div>
                    );
                  })}
                </div>
                {qual.events&&qual.events.length>0&&(
                  <div style={{background:"#0A0A18",border:`1px solid ${F2C}22`,borderRadius:6,padding:14}}>
                    <div style={{fontSize:11,color:F2C,fontWeight:700,letterSpacing:2,marginBottom:10}}>QUALIFYING REPORT</div>
                    {qual.events.map((ev,i)=>(
                      <div key={i} style={{borderLeft:`3px solid ${EVT_C[ev.type]||F2C}`,padding:"7px 12px",marginBottom:5,background:"#0D0D1C",borderRadius:"0 3px 3px 0"}}>
                        <div style={{fontSize:13,lineHeight:1.6}}>{ev.icon} {ev.text}</div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
            {!qual&&<div style={{textAlign:"center",padding:"60px 0",color:"#334",fontSize:16}}>No qualifying data — select a track and run qualifying.</div>}
          </div>
        )}

        {/* SPRINT VIEW */}
        {view==="sprint"&&(
          <div style={{animation:"fadeIn 0.2s ease"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:16}}>
              <div>
                <div style={{fontSize:26,fontWeight:700,letterSpacing:3}}>SPRINT RACE</div>
                <div style={{fontSize:14,color:"#556",letterSpacing:1.5,marginTop:2}}>{track.flag} {track.circuit} · REVERSE TOP-10 GRID · {sprint?.totalLaps||"—"} LAPS{sprint?.runsUsed>1?` · ×${sprint.runsUsed} AVERAGED`:""}</div>
              </div>
              <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
                {sprint?.isWet&&<span style={{background:"#4488FF18",color:"#4488FF",fontSize:12,fontWeight:700,padding:"3px 8px",borderRadius:2}}>🌧️ WET</span>}
                {sprint?.hasSC&&<span style={{background:"#FFC90618",color:"#FFC906",fontSize:12,fontWeight:700,padding:"3px 8px",borderRadius:2}}>🚗 SC L{sprint.scLap}</span>}
                {sprintLocked?<span style={{fontSize:13,color:"#445"}}>Run qualifying first</span>:<button onClick={doSprint} style={{background:"#111120",color:"#667",border:"1px solid #1A1A30",padding:"6px 14px",cursor:"pointer",fontFamily:"inherit",fontSize:13,fontWeight:700,borderRadius:3}}>↺ RE-RUN</button>}
                <button onClick={doRace} style={{background:"#44CC8818",color:"#44CC88",border:"1px solid #44CC8855",padding:"6px 16px",cursor:"pointer",fontFamily:"inherit",fontSize:13,fontWeight:700,borderRadius:3}}>▶ FEATURE RACE →</button>
              </div>
            </div>
            {sprint?(
              <div style={{display:"grid",gridTemplateColumns:"1fr 340px",gap:16,alignItems:"start"}}>
                <div>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6}}>
                    {(()=>{const _ss=new Set();return sprint.positions.filter(e=>{if(_ss.has(e.driver.id)) return false;_ss.add(e.driver.id);return true;}).slice(0,22);})().map((e,i)=>(
                      <div key={e.driver.id} style={{display:"flex",alignItems:"center",gap:9,padding:"9px 13px",background:e.dnf?"#150A0A":i<3?"#0D0D1C":"#0E0E1E",border:`1px solid ${e.dnf?"#FF444422":i<3?"#FFC90618":"#1A1A30"}`,borderLeft:`3px solid ${e.dnf?"#FF4444":e.team.color}`,borderRadius:3,opacity:e.dnf?0.7:1}}>
                        <div style={{width:26,height:26,display:"flex",alignItems:"center",justifyContent:"center",background:i===0?"#FFC906":i===1?"#aaa":i===2?"#CD7F32":"transparent",color:i<3?"#000":"#556",fontSize:11,fontWeight:700,borderRadius:2,border:i>=3?"1px solid #1A1A30":"none",flexShrink:0}}>{e.dnf?"DNF":i+1}</div>
                        <div style={{flex:1,minWidth:0}}>
                          <div style={{fontSize:13,fontWeight:700,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{e.driver.flag} {e.driver.name}</div>
                          <div style={{fontSize:11,color:e.team.color,letterSpacing:1}}>{e.team.name}</div>
                        </div>
                        <div style={{textAlign:"right",flexShrink:0}}>
                          {e.dnf?<div style={{fontSize:11,color:"#FF4444"}}>L{e.dnfLap||"?"}</div>:<>
                            <div style={{fontSize:12,fontFamily:"monospace",color:i===0?"#FFC906":"#aaa"}}>{i===0?"🏁 WIN":`+${e.gap}s`}</div>
                            {e.points>0&&<div style={{fontSize:11,color:F2C,fontWeight:700}}>+{e.points}pts</div>}
                          </>}
                        </div>
                        <div style={{fontSize:9,color:"#334",flexShrink:0}}>P{e.gridPos}→</div>
                      </div>
                    ))}
                  </div>
                </div>
                <div>
                  <div style={{background:"#0A0A18",border:`1px solid ${F2C}22`,borderRadius:6,padding:14,position:"sticky",top:16}}>
                    <div style={{fontSize:11,color:F2C,fontWeight:700,letterSpacing:2,marginBottom:10}}>SPRINT RACE EVENTS</div>
                    {sprint.events.map((ev,i)=>(
                      <div key={i} style={{borderLeft:`3px solid ${EVT_C[ev.type]||F2C}`,padding:"7px 10px",marginBottom:4,background:"#0D0D1C",borderRadius:"0 3px 3px 0"}}>
                        {ev.lap>0&&<div style={{fontSize:10,color:"#445",marginBottom:1}}>LAP {ev.lap}</div>}
                        <div style={{fontSize:12,lineHeight:1.55}}>{ev.icon} {ev.text}</div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            ):(
              <div style={{textAlign:"center",padding:"60px 0",color:"#334",fontSize:16}}>{sprintLocked?"Run qualifying first to generate the sprint grid.":"No sprint data yet."}</div>
            )}
          </div>
        )}

        {/* FEATURE RACE VIEW */}
        {view==="race"&&(
          <div style={{animation:"fadeIn 0.2s ease"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:16}}>
              <div>
                <div style={{fontSize:26,fontWeight:700,letterSpacing:3}}>FEATURE RACE</div>
                <div style={{fontSize:14,color:"#556",letterSpacing:1.5,marginTop:2}}>{track.flag} {track.circuit} · {race?.totalLaps||"—"} LAPS · MANDATORY PIT STOP{race?.runsUsed>1?` · ×${race.runsUsed} AVERAGED`:""}</div>
              </div>
              <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
                {race?.isWet&&<span style={{background:"#4488FF18",color:"#4488FF",fontSize:12,fontWeight:700,padding:"3px 8px",borderRadius:2}}>🌧️ WET</span>}
                {race?.hasSC&&<span style={{background:"#FFC90618",color:"#FFC906",fontSize:12,fontWeight:700,padding:"3px 8px",borderRadius:2}}>🚗 SC L{race.scLap}</span>}
                {race?.fastestLapName&&<span style={{background:"#BB66FF18",color:"#BB66FF",fontSize:12,fontWeight:700,padding:"3px 8px",borderRadius:2}}>💜 FL: {race.fastestLapName}</span>}
                {raceLocked?<span style={{fontSize:13,color:"#445"}}>Run qualifying first</span>:<button onClick={doRace} style={{background:"#111120",color:"#667",border:"1px solid #1A1A30",padding:"6px 14px",cursor:"pointer",fontFamily:"inherit",fontSize:13,fontWeight:700,borderRadius:3}}>↺ RE-RUN</button>}
                {race&&!raceSaved&&qual&&<button onClick={saveToChampionship} style={{background:"#44CC8818",color:"#44CC88",border:"1px solid #44CC8855",padding:"6px 16px",cursor:"pointer",fontFamily:"inherit",fontSize:13,fontWeight:700,borderRadius:3}}>💾 SAVE TO CHAMPIONSHIP</button>}
                {raceSaved&&<span style={{fontSize:12,color:"#44CC88",fontWeight:700}}>✓ SAVED</span>}
              </div>
            </div>
            {race?(
              <div style={{display:"grid",gridTemplateColumns:"1fr 340px",gap:16,alignItems:"start"}}>
                <div>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6}}>
                    {race.positions.map((e,i)=>(
                      <div key={e.driver.id} style={{display:"flex",alignItems:"center",gap:9,padding:"9px 13px",background:e.dnf?"#150A0A":i<3?"#0D0D1C":"#0E0E1E",border:`1px solid ${e.dnf?"#FF444422":i<3?"#FFC90618":"#1A1A30"}`,borderLeft:`3px solid ${e.dnf?"#FF4444":e.team.color}`,borderRadius:3,opacity:e.dnf?0.7:1}}>
                        <div style={{width:26,height:26,display:"flex",alignItems:"center",justifyContent:"center",background:i===0?"#FFC906":i===1?"#aaa":i===2?"#CD7F32":"transparent",color:i<3?"#000":"#556",fontSize:11,fontWeight:700,borderRadius:2,border:i>=3?"1px solid #1A1A30":"none",flexShrink:0}}>{e.dnf?"DNF":i+1}</div>
                        <div style={{flex:1,minWidth:0}}>
                          <div style={{fontSize:13,fontWeight:700,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{e.driver.flag} {e.driver.name}</div>
                          <div style={{fontSize:11,color:e.team.color,letterSpacing:1}}>{e.team.name} {e.tyreStrat&&<span style={{color:"#445",fontSize:9}}>· {e.tyreStrat}</span>}</div>
                        </div>
                        <div style={{textAlign:"right",flexShrink:0}}>
                          {e.dnf?<div style={{fontSize:11,color:"#FF4444"}}>L{e.dnfLap||"?"}</div>:<>
                            <div style={{fontSize:12,fontFamily:"monospace",color:i===0?"#FFC906":"#aaa"}}>{i===0?"🏁 WIN":`+${e.gap}s`}</div>
                            {e.points>0&&<div style={{fontSize:11,color:"#44CC88",fontWeight:700}}>+{e.points}pts</div>}
                          </>}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
                <div>
                  <div style={{background:"#0A0A18",border:`1px solid #44CC8822`,borderRadius:6,padding:14,position:"sticky",top:16}}>
                    <div style={{fontSize:11,color:"#44CC88",fontWeight:700,letterSpacing:2,marginBottom:10}}>FEATURE RACE EVENTS</div>
                    {race.events.map((ev,i)=>(
                      <div key={i} style={{borderLeft:`3px solid ${EVT_C[ev.type]||"#44CC88"}`,padding:"7px 10px",marginBottom:4,background:"#0D0D1C",borderRadius:"0 3px 3px 0"}}>
                        {ev.lap>0&&<div style={{fontSize:10,color:"#445",marginBottom:1}}>LAP {ev.lap}</div>}
                        <div style={{fontSize:12,lineHeight:1.55}}>{ev.icon} {ev.text}</div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            ):(
              <div style={{textAlign:"center",padding:"60px 0",color:"#334",fontSize:16}}>{raceLocked?"Run qualifying first to generate the feature race grid.":"No feature race data yet."}</div>
            )}
          </div>
        )}

        {/* CHAMPIONSHIP VIEW */}
        {view==="championship"&&(()=>{
          // Aggregate driver & constructor standings
          const driverPts={}, teamPts={};
          const driverWins={}, teamWins={}, driverPodiums={};
          championship.forEach(round=>{
            // Sprint points
            (round.sprint?.positions||[]).forEach(e=>{
              if(!driverPts[e.driverId]) driverPts[e.driverId]={name:e.driverName,flag:e.driverFlag,teamName:e.teamName,teamColor:e.teamColor,pts:0};
              if(!teamPts[e.teamId]) teamPts[e.teamId]={name:e.teamName,color:e.teamColor,pts:0};
              driverPts[e.driverId].pts+=e.points||0;
              teamPts[e.teamId].pts+=e.points||0;
            });
            // Feature race points
            (round.race?.positions||[]).forEach(e=>{
              if(!driverPts[e.driverId]) driverPts[e.driverId]={name:e.driverName,flag:e.driverFlag,teamName:e.teamName,teamColor:e.teamColor,pts:0};
              if(!teamPts[e.teamId]) teamPts[e.teamId]={name:e.teamName,color:e.teamColor,pts:0};
              driverPts[e.driverId].pts+=e.points||0;
              teamPts[e.teamId].pts+=e.points||0;
              if(e.finalPos===1&&!e.dnf){driverWins[e.driverId]=(driverWins[e.driverId]||0)+1;teamWins[e.teamId]=(teamWins[e.teamId]||0)+1;}
              if(e.finalPos<=3&&!e.dnf) driverPodiums[e.driverId]=(driverPodiums[e.driverId]||0)+1;
            });
          });
          const driverStandings=Object.entries(driverPts).map(([id,d])=>({id,...d,wins:driverWins[id]||0,podiums:driverPodiums[id]||0})).sort((a,b)=>b.pts-a.pts);
          const teamStandings=Object.entries(teamPts).map(([id,t])=>({id,...t,wins:teamWins[id]||0})).sort((a,b)=>b.pts-a.pts);
          const maxPts=driverStandings[0]?.pts||1;
          return(
            <div style={{animation:"fadeIn 0.2s ease"}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:16}}>
                <div>
                  <div style={{fontSize:26,fontWeight:700,letterSpacing:3}}>F2 CHAMPIONSHIP</div>
                  <div style={{fontSize:14,color:"#556",letterSpacing:1.5,marginTop:2}}>{championship.length} ROUNDS · FEATURE + SPRINT POINTS</div>
                </div>
                <div style={{display:"flex",gap:6}}>
                  {[["DRIVERS","drivers"],["TEAMS","teams"],["ROUNDS","rounds"]].map(([l,t])=>(
                    <button key={t} onClick={()=>setF2ChampTab(t)} style={{background:f2ChampTab===t?`${F2C}18`:"#111120",color:f2ChampTab===t?F2C:"#556",border:`1px solid ${f2ChampTab===t?F2C+"44":"#1A1A30"}`,padding:"5px 12px",cursor:"pointer",fontFamily:"inherit",fontSize:13,fontWeight:700,letterSpacing:1.5,borderRadius:3}}>{l}</button>
                  ))}
                  {championship.length>0&&<button onClick={()=>{if(window.confirm("Clear all championship data?"))setChampionship([]);}} style={{background:"#1A0808",color:"#FF4444",border:"1px solid #FF444433",padding:"5px 12px",cursor:"pointer",fontFamily:"inherit",fontSize:13,fontWeight:700,borderRadius:3}}>RESET</button>}
                </div>
              </div>

              {championship.length===0&&<div style={{textAlign:"center",padding:"60px 0",color:"#334"}}><div style={{fontSize:32,marginBottom:12}}>🏆</div><div style={{fontSize:16,fontWeight:700,color:"#445"}}>No rounds saved yet — run a full weekend and hit 💾 SAVE TO CHAMPIONSHIP.</div></div>}

              {f2ChampTab==="drivers"&&driverStandings.length>0&&(
                <div style={{display:"grid",gap:6}}>
                  {driverStandings.map((d,i)=>(
                    <div key={d.id} style={{display:"flex",alignItems:"center",gap:12,padding:"11px 16px",background:i===0?"#0D0D1C":"#0E0E1E",border:`1px solid ${i===0?F2C+"33":"#1A1A30"}`,borderLeft:`3px solid ${d.teamColor||F2C}`,borderRadius:4}}>
                      <div style={{width:32,textAlign:"center",fontSize:16,fontWeight:900,color:i===0?F2C:i<3?"#FFC906":"#445"}}>{i+1}</div>
                      <div style={{flex:1}}>
                        <div style={{fontSize:16,fontWeight:700}}>{d.flag} {d.name}</div>
                        <div style={{fontSize:12,color:d.teamColor,letterSpacing:1}}>{d.teamName}</div>
                      </div>
                      <div style={{display:"flex",gap:16,alignItems:"center"}}>
                        <div style={{textAlign:"center"}}><div style={{fontSize:11,color:"#445",letterSpacing:1}}>WINS</div><div style={{fontSize:15,fontWeight:700,color:"#FFC906"}}>{d.wins}</div></div>
                        <div style={{textAlign:"center"}}><div style={{fontSize:11,color:"#445",letterSpacing:1}}>PDMS</div><div style={{fontSize:15,fontWeight:700,color:"#aaa"}}>{d.podiums}</div></div>
                        <div style={{textAlign:"right",minWidth:60}}>
                          <div style={{fontSize:22,fontWeight:900,color:i===0?F2C:"#F0F0F0"}}>{d.pts}</div>
                          <div style={{fontSize:9,color:"#445",letterSpacing:1}}>POINTS</div>
                        </div>
                      </div>
                      <div style={{width:100}}>
                        <div style={{height:6,background:"#111120",borderRadius:3}}><div style={{height:6,width:`${(d.pts/maxPts)*100}%`,background:d.teamColor||F2C,borderRadius:3}}/></div>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {f2ChampTab==="teams"&&teamStandings.length>0&&(
                <div style={{display:"grid",gap:6}}>
                  {teamStandings.map((t,i)=>(
                    <div key={t.id} style={{display:"flex",alignItems:"center",gap:12,padding:"11px 16px",background:"#0E0E1E",border:`1px solid ${i===0?t.color+"33":"#1A1A30"}`,borderTop:`3px solid ${t.color}`,borderRadius:4}}>
                      <div style={{width:32,textAlign:"center",fontSize:16,fontWeight:900,color:i===0?t.color:"#445"}}>{i+1}</div>
                      <div style={{flex:1}}>
                        <div style={{fontSize:17,fontWeight:700}}>{t.name}</div>
                        <div style={{fontSize:12,color:"#556",letterSpacing:1}}>{t.wins} wins</div>
                      </div>
                      <div style={{fontSize:24,fontWeight:900,color:i===0?t.color:"#F0F0F0"}}>{t.pts}</div>
                      <div style={{width:100}}><div style={{height:6,background:"#111120",borderRadius:3}}><div style={{height:6,width:`${(t.pts/(teamStandings[0]?.pts||1))*100}%`,background:t.color,borderRadius:3}}/></div></div>
                    </div>
                  ))}
                </div>
              )}

              {f2ChampTab==="rounds"&&championship.length>0&&(
                <div style={{display:"grid",gap:8}}>
                  {[...championship].reverse().map(r=>(
                    <div key={r.id} style={{background:"#0E0E1E",border:"1px solid #1A1A30",borderLeft:`3px solid ${F2C}`,borderRadius:4,padding:14}}>
                      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
                        <div>
                          <div style={{fontSize:16,fontWeight:700}}>{r.trackFlag} Round {r.round} — {r.trackName}</div>
                          <div style={{fontSize:12,color:"#556",marginTop:2}}>{r.trackCircuit}</div>
                        </div>
                        <div style={{display:"flex",gap:6}}>
                          {r.race?.isWet&&<span style={{background:"#4488FF18",color:"#4488FF",fontSize:11,fontWeight:700,padding:"2px 6px",borderRadius:2}}>🌧️ WET</span>}
                          {r.race?.hasSC&&<span style={{background:"#FFC90618",color:"#FFC906",fontSize:11,fontWeight:700,padding:"2px 6px",borderRadius:2}}>🚗 SC</span>}
                        </div>
                      </div>
                      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                        {r.sprint&&(
                          <div>
                            <div style={{fontSize:11,color:"#FFC906",fontWeight:700,letterSpacing:1.5,marginBottom:6}}>⚡ SPRINT</div>
                            {r.sprint.positions.slice(0,3).map((e,i)=>(
                              <div key={e.driverId} style={{display:"flex",alignItems:"center",gap:8,marginBottom:3}}>
                                <span style={{fontSize:11,color:i===0?"#FFC906":"#445",fontWeight:700,width:16}}>{i+1}</span>
                                <span style={{fontSize:12,fontWeight:700}}>{e.driverFlag} {e.driverName}</span>
                                {e.points>0&&<span style={{fontSize:11,color:F2C,marginLeft:"auto"}}>+{e.points}pts</span>}
                              </div>
                            ))}
                          </div>
                        )}
                        <div>
                          <div style={{fontSize:11,color:"#44CC88",fontWeight:700,letterSpacing:1.5,marginBottom:6}}>🏁 FEATURE</div>
                          {(r.race?.positions||[]).slice(0,3).map((e,i)=>(
                            <div key={e.driverId} style={{display:"flex",alignItems:"center",gap:8,marginBottom:3}}>
                              <span style={{fontSize:11,color:i===0?"#FFC906":"#445",fontWeight:700,width:16}}>{i+1}</span>
                              <span style={{fontSize:12,fontWeight:700}}>{e.driverFlag} {e.driverName}</span>
                              {e.points>0&&<span style={{fontSize:11,color:"#44CC88",marginLeft:"auto"}}>+{e.points}pts</span>}
                            </div>
                          ))}
                          {r.race?.fastestLapName&&<div style={{fontSize:10,color:"#BB66FF",marginTop:4}}>💜 FL: {r.race.fastestLapName}</div>}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })()}

      </div>

      {modal&&<F2EditModal type={modal.type} data={modal.data} teams={teams} drivers={drivers} onSave={d=>{modal.type==="driver"?saveDriver(d):saveTeam(d);setModal(null);}} onClose={()=>setModal(null)}/>}
    </div>
    </ErrorBoundary>
  );
}

const SERIES = [
  {
    id:"f1",   active:true,
    name:"Formula 1",    subtitle:"2027 World Championship",
    icon:"🏎️",
    color:"#E8002D", glow:"#E8002D",
    accent:"#FF4444",
    bg:"#180808",
    badge:"SEASON ACTIVE",
    desc:"24 races · 22 drivers · 11 teams · AI commentary",
  },
  {
    id:"f2",   active:true,
    name:"Formula 2",    subtitle:"2027 Championship",
    icon:"🏁",
    color:"#0067FF", glow:"#0055CC",
    accent:"#4499FF",
    bg:"#080A18",
    badge:"SEASON ACTIVE",
    desc:"14 rounds · 20 drivers · 10 teams · Spec Dallara · Setup builder",
  },
  {
    id:"f3",   active:false,
    name:"Formula 3",    subtitle:"2027 Championship",
    icon:"⚡",
    color:"#00A19C", glow:"#007A76",
    accent:"#00CCC7",
    bg:"#080F0F",
    badge:"COMING SOON",
    desc:"Junior formula racing · Road to F1 storylines",
  },
  {
    id:"f4",   active:false,
    name:"Formula 4",    subtitle:"2027 Series",
    icon:"🔰",
    color:"#FF6B00", glow:"#CC5500",
    accent:"#FF8844",
    bg:"#180D00",
    badge:"COMING SOON",
    desc:"Entry-level single seaters · National championships",
  },
  {
    id:"fe",   active:false,
    name:"Formula E",    subtitle:"Season 13",
    icon:"⚡",
    color:"#00E500", glow:"#00BB00",
    accent:"#44FF44",
    bg:"#080F08",
    badge:"COMING SOON",
    desc:"Electric street racing · Attack Mode · Gen4 cars",
  },
  {
    id:"gt",   active:false,
    name:"GT Racing",    subtitle:"2027 GT World Challenge",
    icon:"🏆",
    color:"#B8860B", glow:"#8B6914",
    accent:"#FFD700",
    bg:"#141008",
    badge:"COMING SOON",
    desc:"GT3 machines · Pro & Am categories · Endurance rounds",
  },
];

function EntryMenu({onSelect}) {
  const [hovered, setHovered] = React.useState(null);
  const [entering, setEntering] = React.useState(false);

  const launch = (series) => {
    if (!series.active || entering) return;
    setEntering(true);
    setTimeout(() => onSelect(series.id), 400);
  };

  return (
    <div style={{
      position:"fixed", inset:0, background:"#06060A",
      display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center",
      fontFamily:"'Rajdhani','Segoe UI',sans-serif", overflow:"hidden",
      opacity:entering?0:1, transition:"opacity 0.4s ease",
    }}>
      {/* Background grid lines */}
      <div style={{position:"absolute",inset:0,backgroundImage:"linear-gradient(rgba(255,255,255,0.015) 1px, transparent 1px),linear-gradient(90deg, rgba(255,255,255,0.015) 1px, transparent 1px)",backgroundSize:"60px 60px",pointerEvents:"none"}}/>

      {/* Animated top accent bar */}
      <div style={{position:"absolute",top:0,left:0,right:0,height:3,background:"linear-gradient(90deg,#E8002D,#FF6B00,#0067FF,#00E500,#B8860B,#E8002D)",backgroundSize:"200% 100%",animation:"gradientShift 4s linear infinite"}}/>

      {/* Logo */}
      <div style={{textAlign:"center",marginBottom:40,zIndex:1}}>
        <div style={{fontSize:13,color:"#555",letterSpacing:6,marginBottom:8}}>MOTORSPORT SIMULATOR</div>
        <div style={{fontSize:44,fontWeight:900,letterSpacing:8,color:"#F0F0F0",lineHeight:1}}>
          <span style={{color:"#E8002D"}}>SIM</span> SERIES
        </div>
        <div style={{fontSize:13,color:"#444",letterSpacing:4,marginTop:8}}>SELECT YOUR CHAMPIONSHIP</div>
      </div>

      {/* Series grid */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(3,260px)",gap:12,zIndex:1,maxWidth:820}}>
        {SERIES.map(s=>{
          const isHov = hovered===s.id;
          return(
            <div key={s.id}
              onMouseEnter={()=>s.active&&setHovered(s.id)}
              onMouseLeave={()=>setHovered(null)}
              onClick={()=>launch(s)}
              style={{
                background:isHov?s.bg:"#0C0C0F",
                border:`1px solid ${isHov?s.color+"88":"#1E1E22"}`,
                borderTop:`3px solid ${s.active?s.color:"#1E1E22"}`,
                borderRadius:6,
                padding:"20px 22px",
                cursor:s.active?"pointer":"default",
                transition:"all 0.2s ease",
                opacity:s.active?1:0.45,
                boxShadow:isHov?`0 0 24px ${s.glow}44`:"none",
                transform:isHov?"translateY(-3px)":"none",
              }}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:10}}>
                <span style={{fontSize:26}}>{s.icon}</span>
                <span style={{
                  fontSize:9,fontWeight:700,letterSpacing:1.5,
                  padding:"3px 7px",borderRadius:2,
                  background:s.active?`${s.color}22`:"#1A1A1A",
                  color:s.active?s.color:"#555",
                  border:`1px solid ${s.active?s.color+"44":"#2A2A2A"}`,
                }}>{s.badge}</span>
              </div>
              <div style={{fontSize:18,fontWeight:700,color:isHov?s.color:"#F0F0F0",letterSpacing:1,marginBottom:3}}>{s.name}</div>
              <div style={{fontSize:12,color:isHov?s.accent:"#667",letterSpacing:1,marginBottom:10}}>{s.subtitle}</div>
              <div style={{fontSize:12,color:"#557",lineHeight:1.6,borderTop:`1px solid #1E1E22`,paddingTop:10}}>{s.desc}</div>
              {s.active&&(
                <div style={{marginTop:12,display:"flex",alignItems:"center",gap:6,color:isHov?s.color:"#667",fontSize:12,fontWeight:700,letterSpacing:1.5}}>
                  {isHov?"▶ LAUNCH":"READY TO RACE"}
                  <span style={{width:isHov?20:0,height:1,background:s.color,display:"inline-block",transition:"width 0.2s"}}/>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Version footer */}
      <div style={{position:"absolute",bottom:76,left:0,right:0,textAlign:"center",fontSize:11,color:"#2A2A30",letterSpacing:2}}>
        SIM SERIES v2027.1 — F1 SEASON ACTIVE
      </div>

      <style>{`
        @keyframes gradientShift{0%{background-position:0% 50%}100%{background-position:200% 50%}}
      `}</style>
    </div>
  );
}

class ErrorBoundary extends React.Component {
  constructor(p){super(p);this.state={err:null};}
  static getDerivedStateFromError(e){return{err:e};}
  render(){
    if(this.state.err){
      return React.createElement('div',{style:{padding:32,fontFamily:'monospace',background:'#0C0C0F',minHeight:'100vh'}},
        React.createElement('div',{style:{fontSize:20,fontWeight:700,color:'#E8002D',marginBottom:12}},'⚠️ F1 SIM — RENDER ERROR'),
        React.createElement('pre',{style:{fontSize:12,color:'#FF8844',whiteSpace:'pre-wrap',background:'#111',padding:16,borderRadius:4}},this.state.err.stack||String(this.state.err)),
        React.createElement('button',{onClick:()=>this.setState({err:null}),style:{marginTop:16,background:'#E8002D',color:'#fff',border:'none',padding:'8px 20px',cursor:'pointer',fontFamily:'monospace',fontSize:14,fontWeight:700,borderRadius:3}},'↺ DISMISS')
      );
    }
    return this.props.children;
  }
}

export default function F1Sim(){
  const [showMenu,setShowMenu]=React.useState(()=>{
    try{const s=localStorage.getItem('f1sim_series');return s!=='f1'&&s!=='f2';}catch{return true;}
  });
  const [selectedSeries,setSelectedSeries]=React.useState(()=>{
    try{return localStorage.getItem('f1sim_series')||'f1';}catch{return 'f1';}
  });
  const [drivers,setDrivers]=useState(()=>{
    try{
      const s=localStorage.getItem('f1sim_drivers');
      if(!s) return DRIVERS;
      const seen=new Set();
      return JSON.parse(s).filter(d=>{if(seen.has(d.id)) return false;seen.add(d.id);return true;}).slice(0,22);
    }catch{return DRIVERS;}
  });
  const [teams,setTeams]=useState(()=>{
    try{const s=localStorage.getItem('f1sim_teams');return s?JSON.parse(s):TEAMS;}catch{return TEAMS;}
  });
  const [track,setTrack]=useState(TRACKS[0]);
  const [view,setView]=useState("garage");
  const [gTab,setGTab]=useState("drivers");
  const [qual,setQual]=useState(null);           // {q1,q2,q3,grid}
  const [sprintQual,setSprintQual]=useState(null); // {sq1,sq2,sq3,sprintGrid} — sprint tracks only
  const [fp1,setFp1]=useState(null);             // FP1 session results
  const [fp2,setFp2]=useState(null);             // FP2 session results (null on sprint weekends)
  const [qTab,setQTab]=useState("q3");           // which qualifying session to display
  const [sprint,setSprint]=useState(null);
  const [race,setRace]=useState(null);
  const [stages,setStages]=useState(null);
  const [raceQuarter,setRaceQuarter]=useState(0);
  const [isGen,setIsGen]=useState(false);
  const [genMsg,setGenMsg]=useState("");
  const [modal,setModal]=useState(null);
  const [activeS,setActiveS]=useState(0);
  const [championship,setChampionship]=useState(()=>{
    try{const s=localStorage.getItem('f1sim_champ');return s?JSON.parse(s):[];}catch{return [];}
  });
  const [raceSaved,setRaceSaved]=useState(false);
  const [dbSaving,setDbSaving]=useState(false);
  const [selectedRound,setSelectedRound]=useState(null);
  const [teamBudgets,setTeamBudgets]=useState(()=>{try{const s=localStorage.getItem('f1sim_budgets');return s?JSON.parse(s):initBudgets();}catch{return initBudgets();}});
  // auto-save
  React.useEffect(()=>{
    try{localStorage.setItem('f1sim_drivers',JSON.stringify(drivers));}catch(e){}
  },[drivers]);
  React.useEffect(()=>{
    try{localStorage.setItem('f1sim_teams',JSON.stringify(teams));}catch(e){}
  },[teams]);
  React.useEffect(()=>{
    try{localStorage.setItem('f1sim_champ',JSON.stringify(championship));}catch(e){}
  },[championship]);
  React.useEffect(()=>{
    try{localStorage.setItem('f1sim_budgets',JSON.stringify(teamBudgets));}catch(e){}
  },[teamBudgets]);

  // save/load
  const exportSave=()=>{
    const save={
      version:"2027.1",
      savedAt:new Date().toISOString(),
      series:"f1",
      drivers,teams,championship,
    };
    const blob=new Blob([JSON.stringify(save,null,2)],{type:"application/json"});
    const url=URL.createObjectURL(blob);
    const a=document.createElement('a');
    a.href=url;
    a.download=`f1sim-save-${new Date().toISOString().slice(0,10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };


  const importSave=(e)=>{
    const file=e.target.files[0];
    if(!file) return;
    const reader=new FileReader();
    reader.onload=ev=>{
      try{
        const save=JSON.parse(ev.target.result);
        if(save.drivers) setDrivers(save.drivers);
        if(save.teams)   setTeams(save.teams);
        if(save.championship) setChampionship(save.championship);
        setSelectedRound(null);
        alert(`Save loaded! ${save.championship?.length||0} championship rounds restored.`);
      }catch(err){alert('Could not load save file — invalid format.');}
    };
    reader.readAsText(file);
    e.target.value='';
  };

 // id of round to view detail
  const [champTab,setChampTab]=useState("drivers");
  const [simCount,setSimCount]=useState(10);

  const [liveSession,setLiveSession]=useState(null);
  const [liveLaps,setLiveLaps]=useState([]);
  const [liveDrivers,setLiveDrivers]=useState([]);
  const [liveWeather,setLiveWeather]=useState(null);
  const [liveRaceCtrl,setLiveRaceCtrl]=useState([]);
  const [liveLoading,setLiveLoading]=useState(false);
  const [liveError,setLiveError]=useState("");
  const [pendingUpdates,setPendingUpdates]=useState([]);
  const [updatesApplied,setUpdatesApplied]=useState(false);
  const [simHistory,setSimHistory]=useState(()=>{try{const s=localStorage.getItem('f1sim_simhist');return s?JSON.parse(s):[];}catch{return [];}});


  const [communityEnabled,setCommunityEnabled]=useState(()=>{
    try{
      const stored=localStorage.getItem('f1sim_community');
      return stored===null ? COMMUNITY_ENABLED_BY_DEFAULT : stored==='1';
    }catch{return COMMUNITY_ENABLED_BY_DEFAULT;}
  });
  const [communityData,setCommunityData]=useState(null);   // fetched per-circuit
  const [communityStats,setCommunityStats]=useState(null); // global aggregate
  const [communityLoading,setCommunityLoading]=useState(false);
  const sessionId=React.useMemo(()=>getSessionId(),[]);

  React.useEffect(()=>{
    try{localStorage.setItem('f1sim_community',communityEnabled?'1':'0');}catch(e){}
  },[communityEnabled]);

  React.useEffect(()=>{
    if(!communityEnabled||SUPABASE_URL.includes('YOUR_PROJECT')) return;
    setCommunityLoading(true);
    sbSelect('community_model',`&circuit_id=eq.${track.id}`).then(rows=>{
      setCommunityData(rows||null);
      setCommunityLoading(false);
    });
  },[track.id,communityEnabled]);

  const [allCircuitData,setAllCircuitData]=useState(null);
  const [dbSubmitCount,setDbSubmitCount]=useState(0);
  const [dbError,setDbError]=useState(false);
  React.useEffect(()=>{
    if(!communityEnabled||SUPABASE_URL.includes('YOUR_PROJECT')) return;
    sbSelect('community_global','',50).then(rows=>{
      setCommunityStats(rows&&rows.length?rows[0]:null);
    });
    // Fetch ALL community_model rows for the LightGBM dashboard
    sbSelect('community_model','&order=sample_count.desc',500).then(rows=>{
      setAllCircuitData(rows||null);
    });
  },[communityEnabled]);


  const submitSimData=async(results,actualWinner=null)=>{
    if(!communityEnabled||SUPABASE_URL.includes('YOUR_PROJECT')||SUPABASE_KEY.includes('YOUR_')) return;
    const payload={
      session_id:sessionId,
      circuit_id:track.id,
      sim_accuracy:simCount,
      // Predicted top-5 (what the model thinks)
      predicted_top5:results.slice(0,5).map(r=>({
        driver_id:r.driver?.id, win_pct:r.winPct, podium_pct:r.podiumPct, avg_pos:r.avgPos,
      })),
      // Anonymised driver stats as the user has them configured
      // This lets us see how people tune stats and whether those tunes predict better
      driver_stats:drivers.map(d=>({
        id:d.id, pace:d.pace, consistency:d.consistency, wet:d.wet,
        overtaking:d.overtaking, defense:d.defense, experience:d.experience,
        mental:d.mental, style:d.style,
      })),
      team_paces:teams.map(t=>({id:t.id,pace:t.carPace})),
      // Actual result (if saving to championship — enables accuracy tracking)
      actual_winner_id:actualWinner||null,
      prediction_correct:actualWinner&&results[0]?.driver?.id===actualWinner||null,
      series:'f1',
    };
    const result = await sbInsert('race_sims',payload);
    if(result) {
      console.log('[F1 SIM] ✅ Sim data sent to Supabase:', payload.circuit_id, 'accuracy:×'+payload.sim_accuracy);
      // Show a brief toast in the stats tab count
      setDbSubmitCount(p=>p+1);
    } else {
      console.warn('[F1 SIM] ⚠️ Supabase insert failed - check F12 console for details');
      setDbError(true);
    }
  };

  React.useEffect(()=>{
    try{localStorage.setItem('f1sim_simhist',JSON.stringify(simHistory.slice(-200)));}catch(e){}
  },[simHistory]);
  const [simResults,setSimResults]=useState(null);
  const [simRunning,setSimRunning]=useState(false);
  const [runAccuracy,setRunAccuracy]=useState(10);
  const [testSession,setTestSession]=useState(null);
  const [testResults,setTestResults]=useState(null);
  const [testTab,setTestTab]=useState("barcelona_test");
  const [testDay,setTestDay]=useState(0); // 0 = overall, 1/2/3 = day
  const [apiKey,setApiKey]=useState(()=>{try{return localStorage.getItem("f1sim_ak")||"";}catch{return "";}});
  const [apiKeyInput,setApiKeyInput]=useState("");
  const saveApiKey=()=>{if(apiKeyInput.startsWith("sk-")){try{localStorage.setItem("f1sim_ak",apiKeyInput);}catch{}setApiKey(apiKeyInput);setApiKeyInput("");}};
  const clearApiKey=()=>{try{localStorage.removeItem("f1sim_ak");}catch{}setApiKey("");setApiKeyInput("");};

  const teamDrivers=id=>drivers.filter(d=>d.teamId===id);

  const doQual=()=>{
    const activeDrivers=drivers.slice(0,22);
    setFp1(runFP(1,activeDrivers,teams,track));
    if(track.hasSprint){
      setFp2(null);
      setSprintQual(aggSprintQual(runAccuracy,activeDrivers,teams,track));
    } else {
      setFp2(runFP(2,activeDrivers,teams,track));
      setSprintQual(null);
    }
    setQual(aggQual(runAccuracy,activeDrivers,teams,track));
    setSprint(null); setRace(null); setStages(null); setRaceSaved(false); setDbSaving(false);
    setQTab("fp1"); setView("qualifying");
  };
  const doSprint=()=>{
    if(!qual) return;
    const sprintGrid = sprintQual ? sprintQual.sprintGrid : qual.grid;
    setSprint(aggSprint(runAccuracy,sprintGrid,teams,track));
    setView("sprint");
  };
  const doRace=()=>{
    if(!qual) return;
    setRace(aggRace(runAccuracy,qual.grid,teams,track));
    setRaceSaved(false); setRaceQuarter(0); setView("race");
  };

  const saveToChampionship=()=>{
    if(!race||raceSaved) return;
    const entry={
      id:Date.now(),
      round:championship.length+1,
      trackId:track.id,
      trackName:track.name,
      trackFlag:track.flag,
      trackCircuit:track.circuit,
      hasSprint:!!sprint,
      winner:race.positions[0]?.driver.name||"—",
      podium:race.positions.slice(0,3).map(e=>e.driver.name),
      raceResults:race.positions.reduce((a,e)=>({...a,[e.driver.id]:e.points}),{}),
      // Chaos stats tallied at save time
      chaosStats:(()=>{
        const evts=race.events||[];
        const pos=race.positions||[];
        const dnfs=pos.filter(e=>e.dnf);
        const mechanical=dnfs.filter(e=>!e.dnfReason||(e.dnfReason&&!e.dnfReason.match(/collision|crash|barrier|aquaplan|spin/i)));
        const crashes=dnfs.filter(e=>e.dnfReason&&e.dnfReason.match(/collision|crash|barrier|aquaplan/i));
        const safetyCarEvts=evts.filter(e=>e.type==="safetycar"&&e.icon==="🚗");
        const vscEvts=evts.filter(e=>e.type==="vsc"&&e.icon==="🟡");
        const redFlags=evts.filter(e=>e.type==="redflag"&&e.icon==="🔴"&&e.text.includes("RED FLAG"));
        const penalties=pos.filter(e=>e.timePenalty>0);
        return {
          totalDNFs:dnfs.length, crashDNFs:crashes.length, mechanicalDNFs:mechanical.length,
          safetyCars:safetyCarEvts.length, vscs:vscEvts.length, redFlags:redFlags.length,
          timePenalties:penalties.length, isWet:!!race.isWet,
          dnfDrivers:dnfs.map(e=>({name:e.driver?.name||e.driverName||"?",reason:e.dnfReason||"mechanical failure",lap:e.dnfLap})),
          penaltyDrivers:penalties.map(e=>({name:e.driver?.name||e.driverName||"?",secs:e.timePenalty})),
        };
      })(),
      sprintResults:sprint?sprint.positions.reduce((a,e)=>({...a,[e.driver.id]:e.points}),{}):null,
      sprintWinner:sprint?sprint.positions.find(e=>!e.dnf)?.driver.name||null:null,
      sprintTop8:sprint?sprint.positions.filter(e=>!e.dnf&&e.points>0).map(e=>({name:e.driver.name,pts:e.points})):null,
      // Full frozen snapshots (read-only after save)
      snapshot:{
        qual: qual ? {
          grid: qual.grid.map(e=>({
            driverName:e.driver.name, driverFlag:e.driver.flag, driverAbbr:e.driver.abbr,
            teamName:e.team.name, teamColor:e.team.color, driverId:e.driver.id,
          })),
          q1: qual.q1.map(e=>({...e, driver:{name:e.driver.name,flag:e.driver.flag,abbr:e.driver.abbr,id:e.driver.id}, team:{name:e.team.name,color:e.team.color}})),
          q2: qual.q2.map(e=>({...e, driver:{name:e.driver.name,flag:e.driver.flag,abbr:e.driver.abbr,id:e.driver.id}, team:{name:e.team.name,color:e.team.color}})),
          q3: qual.q3.map(e=>({...e, driver:{name:e.driver.name,flag:e.driver.flag,abbr:e.driver.abbr,id:e.driver.id}, team:{name:e.team.name,color:e.team.color}})),
          runsUsed: qual.runsUsed||1,
        } : null,
        fp1: fp1 ? fp1.positions.map(e=>({driverName:e.driver.name,driverFlag:e.driver.flag,driverAbbr:e.driver.abbr,teamName:e.team.name,teamColor:e.team.color,gap:e.gap,laps:e.laps})) : null,
        fp2: fp2 ? fp2.positions.map(e=>({driverName:e.driver.name,driverFlag:e.driver.flag,driverAbbr:e.driver.abbr,teamName:e.team.name,teamColor:e.team.color,gap:e.gap,laps:e.laps})) : null,
        sprintQual: sprintQual ? {
          sq1: sprintQual.sq1.map(e=>({...e,driver:{name:e.driver.name,flag:e.driver.flag,abbr:e.driver.abbr,id:e.driver.id},team:{name:e.team.name,color:e.team.color}})),
          sq2: sprintQual.sq2.map(e=>({...e,driver:{name:e.driver.name,flag:e.driver.flag,abbr:e.driver.abbr,id:e.driver.id},team:{name:e.team.name,color:e.team.color}})),
          sq3: sprintQual.sq3.map(e=>({...e,driver:{name:e.driver.name,flag:e.driver.flag,abbr:e.driver.abbr,id:e.driver.id},team:{name:e.team.name,color:e.team.color}})),
        } : null,
        sprint: sprint ? {
          positions: sprint.positions.map((e,i)=>({
            finalPos:i+1, driverName:e.driver.name, driverFlag:e.driver.flag, driverId:e.driver.id,
            teamName:e.team.name, teamColor:e.team.color, gap:e.gap, points:e.points, dnf:e.dnf, dnfLap:e.dnfLap,
          })),
          sprintLaps:sprint.sprintLaps,
        } : null,
        race: {
          positions: race.positions.map((e,i)=>({
            finalPos:i+1, driverName:e.driver.name, driverFlag:e.driver.flag, driverId:e.driver.id,
            teamName:e.team.name, teamColor:e.team.color, gap:e.gap, points:e.points, dnf:e.dnf, dnfLap:e.dnfLap,
            gridPos:e.gridPos,
          })),
          events: race.events,
          isWet: race.isWet,
          hasSC: race.hasSC,
          scLap: race.scLap,
          totalLaps: race.totalLaps,
          fastestLapName: race.fastestLap?.name||null,
          fastestLapSeconds: race.fastestLapSeconds||null,
          fastestLapSectors: race.fastestLapSectors||null,
        },
      },
    };
    setChampionship(prev=>[...prev,entry]);
    setRaceSaved(true);
    // Award budget tokens to every team after each race
    setTeamBudgets(prev=>{
      const next={...prev};
      teams.forEach(t=>{next[t.id]=(next[t.id]||0)+1;});
      return next;
    });

    // submit + refresh community model
    if(communityEnabled && !SUPABASE_URL.includes('YOUR_PROJECT')) {
      const actualWinnerId = race.positions[0]?.driver?.id||null;
      setDbSaving(true);
      (async()=>{
        // 1. Submit sim data with actual winner (labelled training example)
        await submitSimData(simResults||[], actualWinnerId);

        // 2. Trigger aggregate_community_model() to update predictions
        try {
          await fetch(`${SUPABASE_URL}/rest/v1/rpc/aggregate_community_model`,{
            method:"POST",
            headers:{
              "apikey":SUPABASE_KEY,
              "Authorization":`Bearer ${SUPABASE_KEY}`,
              "Content-Type":"application/json",
            },
            body:"{}",
          });
          console.log("[F1 SIM] ✅ Community model aggregated");
        } catch(e) {
          console.warn("[F1 SIM] Aggregate skipped:", e.message);
        }

        // 3. Re-fetch community_model for this circuit so UI updates immediately
        const fresh = await sbSelect('community_model',`&circuit_id=eq.${track.id}`);
        if(fresh) setCommunityData(fresh);

        // 4. Re-fetch global stats for the LightGBM dashboard
        const global = await sbSelect('community_global','',50);
        if(global&&global.length) setCommunityStats(global[0]);

        // 5. Re-fetch ALL circuit data for the training volume chart
        const allData = await sbSelect('community_model','&order=sample_count.desc',500);
        if(allData) setAllCircuitData(allData);

        setDbSaving(false);
        console.log("[F1 SIM] ✅ Community data refreshed after save");
      })();
    }

    // Record prediction accuracy if we have simResults from Multi-Sim
    if(simResults&&simResults.length>0) {
      const winner=race.positions[0];
      const pred=simResults[0]; // highest avg-pos = predicted winner
      const correct=winner&&pred&&winner.driver.id===pred.driver.id;
      const podiumDrivers=new Set(race.positions.slice(0,3).map(e=>e.driver.id));
      const podiumPredHit=simResults.slice(0,3).filter(p=>podiumDrivers.has(p.driver.id)).length;
      setSimHistory(prev=>[...prev,{
        round:championship.length+1,
        trackId:track.id,
        trackName:track.name,
        simRuns:simCount,
        accuracy:simCount,
        winnerCorrect:correct,
        podiumHits:podiumPredHit,
        predictedWinner:pred?.driver?.name||"—",
        actualWinner:winner?.driver?.name||"—",
        predWinPct:pred?.winPct||0,
        savedAt:Date.now(),
      }]);
    }
  };

  const getStandings=()=>{
    return drivers.map(d=>{
      let pts=0,wins=0,racePts=0,sprintPts=0;
      championship.forEach(r=>{
        const rp=r.raceResults?.[d.id]||0;
        const sp=r.sprintResults?.[d.id]||0;
        racePts+=rp; sprintPts+=sp; pts+=rp+sp;
        if(r.winner===d.name) wins++;
      });
      return {driver:d,pts,wins,racePts,sprintPts};
    }).sort((a,b)=>b.pts-a.pts||b.wins-a.wins);
  };

  const getConstructorStandings=()=>{
    return teams.map(team=>{
      const tds=drivers.filter(d=>d.teamId===team.id);
      let pts=0,racePts=0,sprintPts=0,wins=0;
      championship.forEach(r=>{
        tds.forEach(d=>{
          const rp=r.raceResults?.[d.id]||0;
          const sp=r.sprintResults?.[d.id]||0;
          racePts+=rp; sprintPts+=sp; pts+=rp+sp;
        });
        if(tds.some(d=>d.name===r.winner)) wins++;
      });
      return {team,pts,racePts,sprintPts,wins,drivers:tds};
    }).sort((a,b)=>b.pts-a.pts||b.wins-a.wins);
  };

  const doCommentary=async()=>{
    if(!race) return;
    setIsGen(true); setStages(null); setActiveS(0); setView("commentary");
    setGenMsg("Wiring up the commentary booth…");
    const grid=qual.grid.map((e,i)=>`P${i+1}: ${e.driver.name} (${e.team.name})`).join("\n");
    const results=race.positions.map((e,i)=>
      e.dnf
        ?`P${i+1}: ${e.driver.name} (${e.team.name}) — DNF lap ${e.dnfLap} [started P${e.gridPos}]`
        :`P${i+1}: ${e.driver.name} (${e.team.name}) — ${i===0?"WINNER":`+${e.gap}s`} [started P${e.gridPos}, ${i<e.gridPos-1?`gained ${e.gridPos-1-i}`:`lost ${i-(e.gridPos-1)}`} pos] ${e.points>0?`${e.points}pts`:""}`
    ).join("\n");
    const evtLog=race.events.map(e=>`[Lap ${e.lap||1}/${L}] ${e.text}`).join("\n");
    const L=race.totalLaps;
    const surnames=drivers.map(d=>d.name.split(" ").pop()).join(", ");
    const dnfList=race.positions.filter(e=>e.dnf).map(e=>`${e.driver.name} (lap ${e.dnfLap})`).join(", ")||"None";
    const chargeList=race.positions.filter((e,i)=>!e.dnf&&e.gridPos-1-i>=4).map(e=>`${e.driver.name} +${e.gridPos-1-race.positions.indexOf(e)} places`).join(", ")||"None";
    const trackMeta=`${track.circuit} | ${track.laps} laps | ${track.lapLen||"~5.0"}km/lap${track.night?" | NIGHT RACE":""}${track.street?" | STREET CIRCUIT":""}${(track.alt||0)>800?` | ALTITUDE ${track.alt}m`:""}${track.abrasive>=7?" | HIGH TYRE WEAR":""}`;

    const prompt=`You are the creative director of SKY SPORTS F1's race broadcast. You are writing a complete, immersive race commentary script for the ${track.name}.

THE COMMENTATORS:

DAVID CROFT ("DC" / key: "CROFT") — The voice of Sky Sports F1. Passionate, electric, emotionally invested.
  • Signature phrases: "IT'S LIGHTS OUT AND AWAY WE GO!", "GO GO GO!", "THAT IS SENSATIONAL!", "OH I SAY!", "Lap [N] of [${L}] and..."
  • Technique: Shouts in CAPITALS for drama. Always says "Lap X of ${L}" to anchor the audience in time. Builds narrative tension across multiple lines. Counts down gaps obsessively ("the gap is 2.3 seconds... 2.1... 1.9 — he's coming!"). Has a slight tendency to catastrophise then correct himself.
  • Emotional range: Pure joy at a winner crossing the line, genuine concern at accidents, childlike excitement at an unexpected overtake.

MARTIN BRUNDLE ("MB" / key: "BRUNDLE") — Former F1 race driver turned analyst. Measured, technically precise, dry British wit.
  • Signature phrases: "I can tell you from personal experience...", "The data will be telling them...", "That is a VERY bold call by the team", "Well now, watch the left rear on that next set...", "When I drove here in [year]..."
  • Technique: Adds technical context immediately after Croft's excitement. Predicts things 2-3 laps before they happen ("I'd watch [driver] — those tyres have done 22 laps and they look cooked"). Occasionally, gently and wryly, corrects Croft. References his own racing past at least twice per race.
  • Emotional range: Measured pride at a great drive, quiet concern about safety, dry amusement at strategy chaos.

THE CONVERSATION: These two are not just exchanging information — they are having a genuine conversation. Croft reacts to what Brundle just said. Brundle picks up on what Croft almost said. They agree, they disagree, they talk over each other (shown by em-dash interruptions). The broadcast feels LIVE.

════════════════════════════════════
RACE DATA — ${track.name}
${trackMeta}
CONDITIONS: ${race.isWet?"WET RACE — intermediates/wets in play":"Dry race"}
SAFETY CAR: ${race.hasSC?`Yes — deployed lap ${race.scLap}, cleared lap ${race.scLap+4}`:"No safety car"}
FASTEST LAP: ${race.fastestLap?.name||"N/A"}
DNFs: ${dnfList}
POSITION GAINERS: ${chargeList}

QUALIFYING GRID:
${grid}

FINAL RACE CLASSIFICATION:
${results}

LAP-BY-LAP EVENTS:
${evtLog}
════════════════════════════════════

WHAT MAKES GREAT F1 COMMENTARY — FOLLOW THESE PRINCIPLES:

1. LAP ANCHORING: Every single line must reference a specific lap number in the format "Lap X of ${L}". This is non-negotiable. Croft counts down ("just 8 laps remaining"), Brundle references specific lap windows for strategy ("the pit window opens around lap ${Math.floor(L*0.28)}-${Math.floor(L*0.35)}").

2. THE GAP GAME: Croft should reference actual gap numbers from the race data and track how they change. "The gap was 3.2 — it's now 2.8 — Brundle, he's coming!" This creates real tension.

3. CHALLENGES & FAILURES: Include genuine jeopardy. Reference:
   - Mechanical sounds/issues before DNFs ("there's smoke from that car — oh, that doesn't look healthy")
   - Tyre degradation concerns ("those fronts are graining badly — lap ${Math.floor(L*0.45)} and they're starting to slide")
   - Near-misses and moments of danger ("CONTACT! They've touched — both cars continue but that was close")
   - Strategic failures ("that was the wrong call — they've given up track position for nothing")
   - Weather threats if applicable

4. TECHNICAL DEPTH (Brundle's domain):
   - DRS: "With ${track.drs||2} DRS zones, the overtaking opportunities are there"
   - Tyre compounds and degradation on this specific surface (abrasive: ${track.abrasive||4}/10)
   - Pit stop delta: "You lose ${track.pitDelta||24} seconds in the pit lane here — teams need a ${Math.ceil((track.pitDelta||24)/1.5)}+ second gap to make the undercut work"
   - Altitude effects if relevant: ${(track.alt||0)>800?`"The ${track.alt}m altitude changes braking distances significantly"`:""}

5. HUMAN DRAMA: Reference driver storylines, championship stakes, personal milestones, team histories at this circuit. Make the audience care about the PEOPLE, not just the cars.

6. MIDFIELD MELEE (dedicated stage): The battle for P8-P22 is its own race. Give it proper coverage. Reference: ${['Hülkenberg','Bortoleto','Gasly','Colapinto','Ocon','Bearman','Stroll','Pérez','Bottas','Lawson','Lindblad'].join(', ')} — ALL must be named here.

7. THE PODIUM STAGE: Post-race reflection, championship standings implications, what this result means for the season. Brundle reflects on the drive of the day. Croft builds to an emotional climax.

STRICT FORMATTING RULES:
- STRICTLY alternate CROFT/BRUNDLE — never two consecutive lines from the same speaker
- Each stage: 9-11 lines of dialogue
- All 22 surnames MUST appear: ${surnames}
- Every line references a specific lap number
- Lines should feel like a conversation, not a presentation

Return ONLY valid JSON — no markdown, preamble, or trailing text:
{"stages":[
  {"key":"start","lines":[{"speaker":"CROFT","text":"..."},{"speaker":"BRUNDLE","text":"..."}]},
  {"key":"early","lines":[...]},
  {"key":"pits","lines":[...]},
  {"key":"mid","lines":[...]},
  {"key":"midfield","lines":[...]},
  {"key":"closing","lines":[...]},
  {"key":"podium","lines":[...]}
]}`;
    setGenMsg("Croft and Brundle are at the microphone…");
    try{
      const res=await fetch("https://api.anthropic.com/v1/messages",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({model:"claude-sonnet-4-20250514",max_tokens:4500,messages:[{role:"user",content:prompt}]})});
      const data=await res.json();
      const raw=data.content?.map(c=>c.text||"").join("")||"";
      setGenMsg("Feeding broadcast to the studio…");
      try{
        const clean=raw.replace(/```json|```/g,"").trim();
        const parsed=JSON.parse(clean);
        if(parsed.stages&&Array.isArray(parsed.stages)){
          setStages(parsed.stages.map(s=>s.lines&&Array.isArray(s.lines)?s:{...s,lines:[{speaker:"CROFT",text:s.text||""}]}));
        } else setStages([{key:"start",lines:[{speaker:"CROFT",text:raw}]}]);
      }catch{
        const paras=raw.split("\n\n").filter(Boolean);
        setStages(STAGE_DEFS.map((s,i)=>({key:s.key,lines:[{speaker:"CROFT",text:paras[i]||paras[0]||"Commentary unavailable."}]})));
      }
    }catch{setStages([{key:"start",lines:[{speaker:"CROFT",text:"Unable to generate commentary — please check connection and try again."}]}]);}
    finally{setIsGen(false);setGenMsg("");}
  };

  const saveDriver=d=>{if(drivers.find(x=>x.id===d.id))setDrivers(p=>p.map(x=>x.id===d.id?d:x));else if(drivers.length<22)setDrivers(p=>[...p,{...d,id:`c_${Date.now()}`}]);setModal(null);};
  const saveTeam=t=>{if(teams.find(x=>x.id===t.id))setTeams(p=>p.map(x=>x.id===t.id?t:x));else setTeams(p=>[...p,{...t,id:`c_${Date.now()}`}]);setModal(null);};
  const setBudgetCap=(teamId,cap)=>setTeamBudgets(prev=>({...prev,[teamId]:Math.max(1,cap)}));

  const surnameMap=buildSurnameMap(drivers,teams);

  const doTest=(session)=>{
    const results=runPreseasonTest(session.days,drivers,teams,session.trackId);
    setTestResults(results);
    setTestSession(session);
    setTestDay(1);
    setView("testing");
  };

  const doMultiSim=()=>{
    setSimRunning(true); setSimResults(null); setView("multisim");
    setTimeout(()=>{
      const results=runMultiSim(simCount,drivers,teams,track);
      setSimResults(results); submitSimData(results); setSimRunning(false);
    },50);
  };

  const showSprint=qual&&track.hasSprint;


  const OF1 = "https://api.openf1.org/v1";

  const of1Get = async (endpoint, params={}) => {
    const qs = Object.entries(params).map(([k,v])=>`${k}=${encodeURIComponent(v)}`).join("&");
    const url = `${OF1}/${endpoint}${qs?"?"+qs:""}`;
    try {
      const r = await fetch(url, {headers:{"Accept":"application/json"}});
      if(!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      return await r.json();
    } catch(e) {
      return null;
    }
  };

  // Driver number → sim driver ID mapping (2024 proxy until 2027 data)
  const OF1_DRIVER_MAP = {
    1:"verstappen",4:"norris",81:"piastri",44:"hamilton",63:"russell",
    16:"leclerc",55:"sainz",11:"perez",14:"alonso",18:"stroll",
    10:"gasly",31:"ocon",77:"bottas",24:"zhou",23:"albon",
    20:"magnussen",27:"hulkenberg",22:"tsunoda",87:"bearman",
    72:"antonelli",30:"lawson",7:"hadjar",12:"bortoleto",43:"colapinto",
    2:"sargeant",5:"lindblad",
  };

  const fetchLatestSession = async (type="Race") => {
    setLiveLoading(true); setLiveError(""); setLiveLaps([]); setLiveDrivers([]);
    const sessions = await of1Get("sessions", {session_type:type});
    if(!sessions||!sessions.length) {
      setLiveError("No sessions found from OpenF1. The API may be unavailable or no data exists yet for this session type.");
      setLiveLoading(false); return;
    }
    const latest = sessions.sort((a,b)=>(b.date_start||"").localeCompare(a.date_start||""))[0];
    setLiveSession(latest);
    const sk = latest.session_key;

    // Fetch in parallel
    const [drvsRaw, weatherRaw, rcRaw, lapsRaw] = await Promise.all([
      of1Get("drivers", {session_key:sk}),
      of1Get("weather",  {session_key:sk}),
      of1Get("race_control",{session_key:sk}),
      of1Get("laps",    {session_key:sk}),
    ]);

    setLiveDrivers(drvsRaw||[]);
    setLiveWeather((weatherRaw||[]).slice(-1)[0]||null);
    setLiveRaceCtrl((rcRaw||[]).filter(e=>e.flag&&e.flag!=="GREEN").slice(-20));

    // Process laps → best lap per driver
    if(lapsRaw&&lapsRaw.length) {
      const bestLaps = {};
      lapsRaw.filter(l=>l.lap_duration&&!l.is_pit_out_lap).forEach(l=>{
        const num=l.driver_number;
        if(!bestLaps[num]||l.lap_duration<bestLaps[num].lap_duration) bestLaps[num]=l;
      });
      setLiveLaps(Object.values(bestLaps).sort((a,b)=>a.lap_duration-b.lap_duration));
    }
    setLiveLoading(false);

    // Compute pending stat updates
    if(lapsRaw&&lapsRaw.length) computePendingUpdates(lapsRaw, drvsRaw||[]);
  };

  const computePendingUpdates = (lapsRaw, drvsRaw) => {
    const drvTeam={};
    drvsRaw.forEach(d=>{ drvTeam[d.driver_number]={teamName:d.team_name,colour:d.team_colour||"#888"}; });

    const bestLaps={};
    lapsRaw.filter(l=>l.lap_duration&&!l.is_pit_out_lap).forEach(l=>{
      const n=l.driver_number;
      if(!bestLaps[n]||l.lap_duration<bestLaps[n]) bestLaps[n]=l.lap_duration;
    });

    const times=Object.values(bestLaps);
    if(!times.length) return;
    const pole=Math.min(...times);
    const maxGap=Math.max(...times)-pole;
    const refMax=Math.max(maxGap,1.5);

    const updates=[];
    drivers.forEach(d=>{
      // Find matching driver number
      const num=parseInt(Object.entries(OF1_DRIVER_MAP).find(([n,id])=>id===d.id)?.[0])||null;
      if(!num||!bestLaps[num]) return;
      const gap=bestLaps[num]-pole;
      const newPace=Math.round(Math.max(72,Math.min(99,97-(gap/refMax)*25)));
      const diff=newPace-d.pace;
      if(Math.abs(diff)>=1) updates.push({driverId:d.id,driverName:d.name,stat:"pace",current:d.pace,suggested:newPace,delta:diff});
    });
    setPendingUpdates(updates);
    setUpdatesApplied(false);
  };

  const applyStatUpdates = () => {
    if(!pendingUpdates.length) return;
    pendingUpdates.forEach(u=>{
      setDrivers(prev=>prev.map(d=>d.id===u.driverId?{...d,[u.stat]:u.suggested}:d));
    });
    setUpdatesApplied(true);
  };


  // Runs silently after each race is saved. Fetches latest qualifying session
  // from OpenF1, computes pace ratings, submits enriched data to Supabase.
  // No UI interaction needed — works in the background automatically.
  const runBackgroundOpenF1 = React.useCallback(async (circuitId) => {
    if(!communityEnabled || SUPABASE_URL.includes('YOUR_PROJECT')) return;
    try {
      // Fetch latest qualifying session
      const sessions = await of1Get("sessions", {session_type:"Qualifying"});
      if(!sessions||!sessions.length) return;
      const latest = sessions.sort((a,b)=>(b.date_start||"").localeCompare(a.date_start||""))[0];
      const sk = latest.session_key;

      // Get lap data
      const [lapsRaw, drvsRaw, weatherRaw] = await Promise.all([
        of1Get("laps", {session_key:sk}),
        of1Get("drivers", {session_key:sk}),
        of1Get("weather", {session_key:sk}),
      ]);
      if(!lapsRaw||!lapsRaw.length) return;

      // Compute best lap per driver
      const bestLaps = {};
      lapsRaw.filter(l=>l.lap_duration&&!l.is_pit_out_lap).forEach(l=>{
        const n=l.driver_number;
        if(!bestLaps[n]||l.lap_duration<bestLaps[n]) bestLaps[n]=l.lap_duration;
      });

      const times = Object.values(bestLaps);
      if(!times.length) return;
      const pole = Math.min(...times);
      const refMax = Math.max(Math.max(...times)-pole, 1.5);

      // Build enriched driver pace ratings from real data
      const realPaceRatings = {};
      Object.entries(bestLaps).forEach(([num, lapTime])=>{
        const did = OF1_DRIVER_MAP[parseInt(num)];
        if(!did) return;
        const gap = lapTime - pole;
        realPaceRatings[did] = Math.round(Math.max(72, Math.min(99, 97-(gap/refMax)*25)));
      });

      // Push enriched submission to Supabase with real F1 data flag
      const enrichedStats = drivers.map(d=>({
        id:d.id, pace: realPaceRatings[d.id]||d.pace,
        consistency:d.consistency, wet:d.wet, overtaking:d.overtaking,
        defense:d.defense, experience:d.experience, mental:d.mental, style:d.style,
        source:"openf1_auto",
      }));

      const wasWet = (weatherRaw||[]).some(w=>w.rainfall);
      const weatherInfo = (weatherRaw||[]).slice(-1)[0]||{};

      await sbInsert("race_sims", {
        session_id: sessionId,
        circuit_id: circuitId||track.id,
        series: "f1",
        sim_accuracy: 20,
        predicted_top5: (simResults||[]).slice(0,5).map(r=>({
          driver_id:r.driver?.id, win_pct:r.winPct||0,
          podium_pct:r.podiumPct||0, avg_pos:r.avgPos||11,
        })),
        driver_stats: enrichedStats,
        team_paces: teams.map(t=>{const s=getTeamStats(t);return{id:t.id,pace:s.carPace};}),
        actual_winner_id: null,
        prediction_correct: null,
        openf1_session_key: sk,
        was_wet: wasWet,
        track_temp: weatherInfo.track_temperature||null,
        data_source: "openf1_background",
      });
      console.log("[F1 SIM] Background OpenF1 sync complete for", circuitId||track.id);
    } catch(e) {
      console.log("[F1 SIM] Background OpenF1 sync skipped:", e.message);
    }
  }, [communityEnabled, track.id, drivers, teams, simResults, sessionId]);

  // Auto-trigger background sync when a race is saved to championship
  React.useEffect(()=>{
    if(raceSaved && communityEnabled) {
      setTimeout(()=>runBackgroundOpenF1(track.id), 2000);
    }
  }, [raceSaved]);

  const NAVS=[
    {v:"garage",l:"GARAGE"},{v:"tracks",l:"TRACKS"},
    {v:"qualifying",l:"QUALIFYING",locked:!qual},
    {v:"sprint",l:"SPRINT",locked:!showSprint||!sprint,hidden:!track.hasSprint},
    {v:"race",l:"RACE",locked:!race},
    {v:"testing",l:"🔬 TESTING"},
    {v:"multisim",l:"📊 MULTI-SIM"},
    {v:"stats",l:"📈 STATS"},
    {v:"commentary",l:"COMMENTARY",locked:!race},
    {v:"championship",l:"🏆 CHAMP"},
    {v:"guide",l:"📖 GUIDE"},
  ];
  const nb=(a,lk)=>({background:a?"#E8002D":"transparent",color:a?"#fff":lk?"#2A2A2A":"#bbb",border:"none",padding:"0 12px",height:58,cursor:lk?"default":"pointer",fontFamily:"inherit",fontSize:14,fontWeight:700,letterSpacing:1.5,transition:"all 0.15s",borderRight:"1px solid #1A1A1E",pointerEvents:lk?"none":"auto"});

  if(showMenu) return <EntryMenu onSelect={id=>{
    try{localStorage.setItem('f1sim_series',id);}catch{}
    setSelectedSeries(id);
    setShowMenu(false);
  }}/>;

  if(selectedSeries==='f2') return <F2Sim onBack={()=>{try{localStorage.removeItem('f1sim_series');}catch{}setShowMenu(true);}}/>;

  return(
    <ErrorBoundary>
    <div style={{background:"#0C0C0F",minHeight:"100vh",fontFamily:"'Rajdhani','Segoe UI',sans-serif",color:"#F0F0F0"}}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Rajdhani:wght@400;500;600;700&display=swap');
        html{font-size:16px}
        *{box-sizing:border-box;margin:0;padding:0}
        ::-webkit-scrollbar{width:4px;height:4px}::-webkit-scrollbar-track{background:#111}::-webkit-scrollbar-thumb{background:#2A2A30}
        input[type=range]{accent-color:#E8002D;cursor:pointer;width:100%} select option{background:#1E1E22}
        .hov:hover{background:#1E1E26!important} .hov-t:hover{border-color:#E8002D44!important;background:#141418!important}
        @keyframes pulse{0%,100%{opacity:0.25}50%{opacity:1}}
        @keyframes fadeIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
        @keyframes slideIn{from{opacity:0;transform:translateX(-10px)}to{opacity:1;transform:translateX(0)}}
      `}</style>

      {/* HEADER */}
      <div style={{background:"#111115",borderBottom:"2px solid #E8002D",display:"flex",alignItems:"center",height:58,paddingLeft:14,overflowX:"auto"}}>
        <div style={{fontSize:18,fontWeight:700,letterSpacing:4,color:"#E8002D",marginRight:16,flexShrink:0}}>F1 ▶ SIM</div>
        {NAVS.filter(n=>!n.hidden).map(n=><button key={n.v} onClick={()=>!n.locked&&setView(n.v)} style={nb(view===n.v,n.locked)}>{n.l}</button>)}
        <div style={{marginLeft:"auto",display:"flex",alignItems:"center",gap:8,paddingRight:14,flexShrink:0}}>
          {/* Save / Load */}
          <label title="Load save file" style={{background:"#1A1A1E",color:"#778",border:"1px solid #2A2A30",padding:"3px 9px",cursor:"pointer",fontFamily:"inherit",fontSize:11,fontWeight:700,letterSpacing:1,borderRadius:2,whiteSpace:"nowrap"}}>
            ⬆ LOAD
            <input type="file" accept=".json" onChange={importSave} style={{display:"none"}}/>
          </label>
          <button onClick={exportSave} title="Download save file" style={{background:"#1A1A1E",color:"#778",border:"1px solid #2A2A30",padding:"3px 9px",cursor:"pointer",fontFamily:"inherit",fontSize:11,fontWeight:700,letterSpacing:1,borderRadius:2,whiteSpace:"nowrap"}}>
            ⬇ SAVE
          </button>
          <div style={{width:1,height:20,background:"#2A2A30"}}/>
          {/* Accuracy */}
          <span style={{fontSize:11,color:"#778",letterSpacing:1,whiteSpace:"nowrap"}}>ACCURACY</span>
          {[1,5,10,20].map(n=>(
            <button key={n} onClick={()=>setRunAccuracy(n)} style={{background:runAccuracy===n?"#E8002D22":"transparent",color:runAccuracy===n?"#E8002D":"#778",border:`1px solid ${runAccuracy===n?"#E8002D44":"#2A2A30"}`,padding:"3px 8px",cursor:"pointer",fontFamily:"inherit",fontSize:11,fontWeight:700,letterSpacing:1,borderRadius:2,transition:"all 0.15s"}}>×{n}</button>
          ))}
          <div style={{width:1,height:20,background:"#2A2A30"}}/>
          {/* Back to menu */}
          <button onClick={()=>setShowMenu(true)} title="Back to series select"
            style={{background:"#1A0A0A",color:"#E8002D",border:"1px solid #E8002D55",padding:"5px 14px",cursor:"pointer",fontFamily:"inherit",fontSize:12,fontWeight:700,letterSpacing:1.5,borderRadius:3,whiteSpace:"nowrap",transition:"all 0.15s",display:"flex",alignItems:"center",gap:5}}
            onMouseEnter={e=>{e.currentTarget.style.background="#E8002D22";e.currentTarget.style.borderColor="#E8002D99";}}
            onMouseLeave={e=>{e.currentTarget.style.background="#1A0A0A";e.currentTarget.style.borderColor="#E8002D55";}}>
            ⏏ HOME
          </button>
          <button
            onClick={()=>{setCommunityEnabled(p=>!p);setDbError(false);setDbSubmitCount(0);}}
            title={communityEnabled?"Community model ON — sharing anonymous data":"Community model OFF — click to enable"}
            style={{background:communityEnabled?"#00440022":"transparent",color:communityEnabled?"#44CC88":"#333",border:`1px solid ${communityEnabled?"#44CC8844":"#2A2A30"}`,padding:"3px 9px",cursor:"pointer",fontFamily:"inherit",fontSize:11,fontWeight:700,letterSpacing:1,borderRadius:2,whiteSpace:"nowrap",transition:"all 0.2s"}}>
            {communityEnabled?"🟢 LIVE":"⚫ OFFLINE"}
          </button>
          {communityEnabled&&dbSubmitCount>0&&!dbError&&(
            <span style={{fontSize:10,color:"#44CC88",fontWeight:700,letterSpacing:1}}>↑{dbSubmitCount} sent</span>
          )}
          {communityEnabled&&dbError&&(
            <span style={{fontSize:10,color:"#E8002D",fontWeight:700}} title="Check browser console (F12) for details">⚠️ DB error</span>
          )}
        </div>
      </div>

      <div style={{padding:18,maxWidth:1120,margin:"0 auto"}}>

        
        {view==="garage"&&(
          <div style={{animation:"fadeIn 0.2s ease"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:16}}>
              <div>
                <div style={{fontSize:26,fontWeight:700,letterSpacing:3}}>2027 F1 GARAGE</div>
                <div style={{fontSize:14,color:"#778",letterSpacing:1.5,marginTop:2}}>{drivers.length} DRIVERS · {teams.length} TEAMS · MENTAL STATE · GOOD/BAD TRACKS</div>
              </div>
              <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                {[["DRIVERS","drivers"],["TEAMS","teams"]].map(([l,t])=>(
                  <button key={t} onClick={()=>setGTab(t)} style={{background:gTab===t?"#2A2A30":"transparent",color:gTab===t?"#F0F0F0":"#899",border:"1px solid #2A2A30",padding:"5px 12px",cursor:"pointer",fontFamily:"inherit",fontSize:14,fontWeight:700,letterSpacing:1.5,borderRadius:3}}>{l}</button>
                ))}
                <button onClick={()=>setModal({type:"driver",data:{name:"",abbr:"",num:99,teamId:teams[0]?.id||"",pace:78,consistency:78,wet:75,overtaking:75,defense:75,experience:65,mental:7,flag:"🏁",goodTracks:[],badTracks:[]}})} style={{background:"#E8002D",color:"#fff",border:"none",padding:"5px 12px",cursor:"pointer",fontFamily:"inherit",fontSize:14,fontWeight:700,letterSpacing:1.5,borderRadius:3}}>+ DRIVER</button>
                <button onClick={()=>setModal({type:"team",data:{name:"",abbr:"",color:"#aaa",tc:"#fff",basePitSpeed:78,engine:"Customer",strategy:"one_stop",carPace:67,reliability:70,pitSpeed:76,tyreLife:62,cornering:8,topSpeed:9}})} style={{background:"#2A2A30",color:"#ccc",border:"none",padding:"5px 12px",cursor:"pointer",fontFamily:"inherit",fontSize:14,fontWeight:700,letterSpacing:1.5,borderRadius:3}}>+ TEAM</button>
              </div>
            </div>

            {gTab==="drivers"&&(
              <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(215px,1fr))",gap:10}}>
                {teams.map(team=>teamDrivers(team.id).map(d=>{
                  const goodNames=d.goodTracks?.map(id=>TRACKS.find(t=>t.id===id)?.flag||"").filter(Boolean)||[];
                  const badNames=d.badTracks?.map(id=>TRACKS.find(t=>t.id===id)?.flag||"").filter(Boolean)||[];
                  return(
                    <div key={d.id} className="hov" onClick={()=>setModal({type:"driver",data:d})} style={{background:"#161618",border:`1px solid ${team.color}18`,borderLeft:`3px solid ${team.color}`,borderRadius:4,padding:"13px 15px",cursor:"pointer",transition:"background 0.15s"}}>
                      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:8}}>
                        <div>
                          <div style={{fontSize:13,color:"#778",letterSpacing:1.5}}>{d.flag} #{d.num}</div>
                          <div style={{fontSize:16,fontWeight:700,marginTop:1}}>{d.name}</div>
                          <div style={{fontSize:12,color:team.color,fontWeight:700,letterSpacing:1.5,marginTop:1}}>{team.name}</div>
                        </div>
                        <div style={{fontSize:20,fontWeight:900,color:team.color,opacity:0.6}}>{d.abbr}</div>
                      </div>
                      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:"6px 10px",marginBottom:8}}>
                        {[["PCE",d.pace],["CON",d.consistency],["WET",d.wet]].map(([l,v])=>(
                          <div key={l}><div style={{display:"flex",justifyContent:"space-between",fontSize:12,color:"#778",letterSpacing:1.5}}><span>{l}</span><span style={{color:"#aaa"}}>{v}</span></div><Bar val={v} color={team.color}/></div>
                        ))}
                      </div>
                      <MentalBar val={d.mental||7} color={team.color}/>
                      {(()=>{const sty=DRIVING_STYLES.find(s=>s.id===d.style);return sty?(<div style={{display:"flex",alignItems:"center",gap:5,marginTop:5,marginBottom:2}}><span style={{fontSize:12}}>{sty.icon}</span><span style={{fontSize:10,color:sty.color,fontWeight:700,letterSpacing:1}}>{sty.name.toUpperCase()}</span></div>):null;})()}
                      <div style={{display:"flex",justifyContent:"space-between",marginTop:4,fontSize:12}}>
                        <span style={{color:"#44CC88"}}>{goodNames.join(" ")||"—"}</span>
                        <span style={{color:"#FF4444"}}>{badNames.join(" ")||"—"}</span>
                      </div>
                      {(d.rivals||[]).length>0&&(
                        <div style={{marginTop:5,display:"flex",alignItems:"center",gap:4,flexWrap:"wrap"}}>
                          <span style={{fontSize:9,color:"#E8002D",fontWeight:700,letterSpacing:1}}>⚔️</span>
                          {(d.rivals||[]).map(rid=>{
                            const rd=drivers.find(x=>x.id===rid);
                            return rd?<span key={rid} style={{fontSize:9,color:"#aaa",background:"#E8002D1A",border:"1px solid #E8002D33",padding:"1px 5px",borderRadius:2}}>{rd.name.split(" ").pop()}</span>:null;
                          })}
                        </div>
                      )}
                    </div>
                  );
                }))}
              </div>
            )}

            {gTab==="teams"&&(
              <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(285px,1fr))",gap:12}}>
                {teams.map(t=>(
                  <div key={t.id} className="hov" onClick={()=>setModal({type:"team",data:t})} style={{background:"#161618",border:`1px solid ${t.color}22`,borderTop:`3px solid ${t.color}`,borderRadius:4,padding:16,cursor:"pointer",transition:"background 0.15s"}}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:14}}>
                      <div>
                        <div style={{fontSize:20,fontWeight:700}}>{t.name}</div>
                        <div style={{display:"flex",gap:7,alignItems:"center",marginTop:3}}>
                          {(()=>{const tc=TIER_CONFIG[t.tier||"low"]||TIER_CONFIG.low;return(
                            <span style={{fontSize:9,fontWeight:700,letterSpacing:1.5,color:tc.color,background:tc.color+"1A",padding:"1px 6px",borderRadius:2}}>{tc.label}</span>
                          );})()}
                          <span style={{fontSize:11,color:"#aaa"}}>Cap: <span style={{color:"#FFC906",fontWeight:700}}>£{teamBudgets[t.id]||0}m</span></span>
                        </div>
                      </div>
                      <div style={{background:t.color,color:t.tc||"#fff",fontSize:14,fontWeight:700,padding:"3px 8px",letterSpacing:2.5,borderRadius:2}}>{t.abbr}</div>
                    </div>
                    {(()=>{const _s=getTeamStats(t);return[["CAR PACE",_s.carPace],["RELIABILITY",_s.reliability],["PIT SPEED",_s.pitSpeed]].map(([l,v])=>(
                      <div key={l} style={{marginBottom:9}}><div style={{display:"flex",justifyContent:"space-between",fontSize:13,color:"#778",letterSpacing:1.5,marginBottom:2}}><span>{l}</span><span style={{color:"#bbb"}}>{v}</span></div><Bar val={v} color={t.color}/></div>
                    ));})()} 
                    {(()=>{const st=TEAM_STRATEGIES.find(s=>s.id===t.strategy);return st?(
                      <div style={{display:"flex",alignItems:"center",gap:6,marginTop:8,marginBottom:2}}>
                        <span style={{fontSize:12}}>{st.icon}</span>
                        <span style={{fontSize:10,color:st.color,fontWeight:700,letterSpacing:1}}>{st.name.toUpperCase()}</span>
                      </div>
                    ):null;})()}
                    <div style={{marginTop:4,fontSize:13,color:"#778"}}>{teamDrivers(t.id).map(d=>d.name).join(" · ")||"No drivers"}</div>
                  </div>
                ))}
              </div>
            )}
            <div style={{marginTop:20,display:"flex",justifyContent:"flex-end"}}>
              <button onClick={()=>setView("tracks")} style={{background:"#E8002D",color:"#fff",border:"none",padding:"11px 28px",cursor:"pointer",fontFamily:"inherit",fontSize:16,fontWeight:700,letterSpacing:3,borderRadius:3}}>SELECT TRACK →</button>
            </div>
          </div>
        )}

        
        {view==="tracks"&&(
          <div style={{animation:"fadeIn 0.2s ease"}}>
            <div style={{marginBottom:16}}>
              <div style={{fontSize:26,fontWeight:700,letterSpacing:3}}>2027 RACE CALENDAR</div>
              <div style={{fontSize:14,color:"#778",letterSpacing:1.5,marginTop:2}}>24 CIRCUITS · ⚡ = SPRINT WEEKEND</div>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(225px,1fr))",gap:9}}>
              {TRACKS.map(tr=>(
                <div key={tr.id} className="hov-t" onClick={()=>setTrack(tr)} style={{background:track.id===tr.id?"#161A16":"#161618",border:`1px solid ${track.id===tr.id?"#E8002D":"#2A2A30"}`,borderLeft:`3px solid ${track.id===tr.id?"#E8002D":"#2A2A30"}`,borderRadius:4,padding:"13px 15px",cursor:"pointer",transition:"all 0.15s"}}>
                  <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
                    <span style={{fontSize:20}}>{tr.flag}</span>
                    <div style={{display:"flex",gap:6,alignItems:"center"}}>
                      {tr.hasSprint&&<span style={{fontSize:12,color:"#FFC906",background:"#FFC90620",padding:"1px 5px",borderRadius:2,fontWeight:700}}>⚡ SPRINT</span>}
                      <span style={{fontSize:13,color:"#778",letterSpacing:1.5}}>{tr.laps}L</span>
                    </div>
                  </div>
                  <div style={{fontSize:16,fontWeight:700}}>{tr.name}</div>
                  <div style={{fontSize:13,color:"#899",marginBottom:6}}>{tr.circuit}</div>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:"4px 0",marginBottom:5}}>
                    {[["OVT",100-tr.od,"#44CC88"],["DEG",tr.td,"#FFC906"],["WET",tr.wr,"#4488FF"]].map(([l,v,c])=>(
                      <div key={l}><div style={{fontSize:11,color:"#778",letterSpacing:1.5}}>{l}</div><div style={{height:4,background:"#222",borderRadius:1,marginTop:2}}><div style={{height:4,width:`${v}%`,background:c,borderRadius:1}}/></div></div>
                    ))}
                  </div>
                  <div style={{display:"flex",flexWrap:"wrap",gap:"3px 6px"}}>
                    {tr.drs&&<span style={{fontSize:10,color:"#778"}}>{tr.drs} DRS</span>}
                    {tr.corners&&<span style={{fontSize:10,color:"#778"}}>{tr.corners} turns</span>}
                    {tr.lapLen&&<span style={{fontSize:10,color:"#778"}}>{tr.lapLen}km</span>}
                    {(tr.alt||0)>400&&<span style={{fontSize:10,color:"#FF8844"}}>⛰{tr.alt}m</span>}
                    {tr.night&&<span style={{fontSize:10,color:"#FFC906"}}>🌙</span>}
                    {tr.street&&<span style={{fontSize:10,color:"#4488FF"}}>🏙</span>}
                    {(tr.abrasive||0)>=7&&<span style={{fontSize:10,color:"#FF6644"}}>abrasive</span>}
                    {tr.topSpeed&&<span style={{fontSize:10,color:"#778"}}>{tr.topSpeed}km/h</span>}
                  </div>
                </div>
              ))}
            </div>
            <div style={{marginTop:18,display:"flex",justifyContent:"flex-end"}}>
              <button onClick={doQual} style={{background:"#E8002D",color:"#fff",border:"none",padding:"11px 28px",cursor:"pointer",fontFamily:"inherit",fontSize:16,fontWeight:700,letterSpacing:3,borderRadius:3}}>SIMULATE WEEKEND →</button>
            </div>
          </div>
        )}

        
        {view==="qualifying"&&qual&&(()=>{try{
          // Build tab list: FP1 → (FP2 or SQ1/SQ2/SQ3) → Q1 → Q2 → Q3
          const tabs=[];
          if(fp1) tabs.push({k:"fp1",l:"FP1",sub:"FREE PRACTICE",dur:"60 MIN",color:"#4488FF",kind:"fp",data:fp1});
          if(fp2&&!track.hasSprint) tabs.push({k:"fp2",l:"FP2",sub:"FREE PRACTICE",dur:"60 MIN",color:"#44AAFF",kind:"fp",data:fp2});
          if(sprintQual&&track.hasSprint){
            tabs.push({k:"sq1",l:"SQ1",sub:"ALL DRIVERS",dur:"12 MIN",color:"#BB66FF",kind:"sq",src:sprintQual.sq1,events:sprintQual.sq1Events,elim:12});
            tabs.push({k:"sq2",l:"SQ2",sub:"TOP 12",     dur:"10 MIN",color:"#DD88FF",kind:"sq",src:sprintQual.sq2,events:sprintQual.sq2Events,elim:8});
            tabs.push({k:"sq3",l:"SQ3",sub:"SPRINT GRID",dur:"8 MIN", color:"#FF66FF",kind:"sq",src:sprintQual.sq3,events:sprintQual.sq3Events,elim:null});
          }
          tabs.push({k:"q1",l:"Q1",sub:"ALL DRIVERS",dur:"18 MIN",elim:15,src:qual.q1,events:qual.q1Events,capFn:()=>buildQ1Caption(qual.q1,track),color:"#FF8844",kind:"q"});
          tabs.push({k:"q2",l:"Q2",sub:"TOP 15",     dur:"15 MIN",elim:10,src:qual.q2,events:qual.q2Events,capFn:()=>buildQ2Caption(qual.q2,track),color:"#FFC906",kind:"q"});
          tabs.push({k:"q3",l:"Q3",sub:"POLE SHOOT", dur:"12 MIN",elim:null,src:qual.q3,events:qual.q3Events,capFn:()=>buildQ3Caption(qual.q3,track),color:"#E8002D",kind:"q"});
          const cur=tabs.find(t=>t.k===qTab)||tabs[tabs.length-1];
          return(
            <div style={{animation:"fadeIn 0.2s ease"}}>
              <div style={{marginBottom:14}}>
                <div style={{fontSize:26,fontWeight:700,letterSpacing:3}}>RACE WEEKEND — {track.name.toUpperCase()}</div>
                <div style={{display:"flex",gap:8,alignItems:"center",marginTop:4,flexWrap:"wrap"}}>
                  <div style={{fontSize:14,color:"#778",letterSpacing:1.5}}>{track.flag} {track.circuit}</div>
                  {track.hasSprint&&<span style={{background:"#FFC90620",color:"#FFC906",fontSize:12,fontWeight:700,padding:"2px 8px",borderRadius:2,letterSpacing:1}}>⚡ SPRINT WEEKEND</span>}
                  {qual.runsUsed>1&&<span style={{background:"#E8002D18",color:"#E8002D",fontSize:12,fontWeight:700,padding:"2px 8px",borderRadius:2,letterSpacing:1}}>⟳ ×{qual.runsUsed} RUNS AVERAGED</span>}
                </div>
              </div>

              {/* Session tabs */}
              <div style={{display:"flex",gap:3,marginBottom:16,background:"#0D0D10",padding:4,borderRadius:5,border:"1px solid #1E1E22",flexWrap:"wrap"}}>
                {tabs.map(t=>(
                  <button key={t.k} onClick={()=>setQTab(t.k)}
                    style={{flex:1,minWidth:52,background:qTab===t.k?`${t.color}22`:"transparent",color:qTab===t.k?t.color:"#677",border:`1px solid ${qTab===t.k?t.color+"55":"transparent"}`,padding:"7px 4px",cursor:"pointer",fontFamily:"inherit",fontSize:13,fontWeight:700,letterSpacing:1,borderRadius:3,transition:"all 0.15s"}}>
                    <div>{t.l}</div>
                    <div style={{fontSize:9,color:qTab===t.k?t.color:"#445",marginTop:2,letterSpacing:0.5}}>{t.sub}</div>
                  </button>
                ))}
              </div>

              {/* FP tab content */}
              {cur&&cur.kind==="fp"&&cur.data&&(
                <div style={{display:"grid",gridTemplateColumns:"1fr 340px",gap:16,alignItems:"start"}}>
                  <div>
                    <div style={{display:"grid",gap:5}}>
                      {cur.data.positions.map((e,i)=>(
                        <div key={e.driver.id} style={{display:"flex",alignItems:"center",gap:10,padding:"9px 14px",background:"#161618",border:"1px solid #1E1E22",borderLeft:`3px solid ${e.team.color}`,borderRadius:3}}>
                          <div style={{width:28,textAlign:"center",fontSize:13,fontWeight:700,color:i<3?"#FFC906":"#666"}}>{i+1}</div>
                          <div style={{width:44,fontFamily:"monospace",fontSize:11,fontWeight:700,color:e.team.color,letterSpacing:1}}>{e.driver.abbr}</div>
                          <div style={{flex:1}}>
                            <div style={{fontSize:14,fontWeight:700}}>{e.driver.name}</div>
                            <div style={{fontSize:11,color:e.team.color,letterSpacing:1}}>{e.team.name}</div>
                          </div>
                          <div style={{textAlign:"right"}}>
                            <div style={{fontSize:13,fontFamily:"monospace",color:i===0?"#FFC906":"#ccc"}}>{e.gap?`+${e.gap}s`:"BEST"}</div>
                            <div style={{fontSize:11,color:"#556"}}>{e.laps} laps</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div>
                    <div style={{background:"#0F0F12",border:`1px solid ${cur.color}22`,borderLeft:`4px solid ${cur.color}`,borderRadius:"0 6px 6px 0",padding:"14px 16px"}}>
                      <div style={{fontSize:11,color:cur.color,fontWeight:700,letterSpacing:2,marginBottom:10}}>{cur.l} REPORT</div>
                      {buildFPCaption(cur.data,track).map((c,i)=>(
                        <p key={i} style={{fontSize:13,color:i===0?"#F0F0F0":"#aaa",lineHeight:1.8,marginBottom:8,whiteSpace:"pre-line"}}>{c}</p>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {/* SQ tab content */}
              {cur&&cur.kind==="sq"&&cur.src&&(
                <div style={{display:"grid",gridTemplateColumns:"1fr 340px",gap:16,alignItems:"start"}}>
                  <div>
                    <QGrid entries={cur.src} gapFrom={cur.src} elimLine={cur.elim} elimColor={cur.color}/>
                  </div>
                  <div>
                    {cur.events&&cur.events.length>0&&(
                      <div style={{marginBottom:12}}>
                        <div style={{fontSize:11,color:cur.color,fontWeight:700,letterSpacing:2,marginBottom:8}}>{cur.l} SESSION EVENTS</div>
                        {cur.events.map((ev,i)=>(
                          <div key={i} style={{borderLeft:`3px solid ${ev.type==="yellow"?"#FFC906":ev.type==="battle"?"#FF8844":ev.type==="strategy"?"#BB66FF":ev.type==="surprise"?"#44CC88":"#4488FF"}`,padding:"9px 12px",marginBottom:6,background:"#161618",borderRadius:"0 4px 4px 0"}}>
                            <div style={{fontSize:13,lineHeight:1.6}}>{ev.icon} {ev.text}</div>
                          </div>
                        ))}
                      </div>
                    )}
                    <div style={{background:"#0F0F12",border:`1px solid ${cur.color}22`,borderLeft:`4px solid ${cur.color}`,borderRadius:"0 6px 6px 0",padding:"14px 16px"}}>
                      <div style={{fontSize:11,color:cur.color,fontWeight:700,letterSpacing:2,marginBottom:10}}>{cur.l} REPORT</div>
                      {buildSQCaption(cur.k.toUpperCase(),cur.src,track).map((c,i)=>(
                        <p key={i} style={{fontSize:13,color:i===0?"#F0F0F0":"#aaa",lineHeight:1.8,marginBottom:8,whiteSpace:"pre-line"}}>{c}</p>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {/* Q tab content */}
              {cur&&cur.kind==="q"&&cur.src&&(
                <div style={{display:"grid",gridTemplateColumns:"1fr 340px",gap:16,alignItems:"start"}}>
                  <div>
                    <QGrid entries={cur.src} gapFrom={cur.src} elimLine={cur.elim} elimColor={cur.color}/>
                  </div>
                  <div>
                    {cur.events&&cur.events.length>0&&(
                      <div style={{marginBottom:12}}>
                        <div style={{fontSize:11,color:cur.color,fontWeight:700,letterSpacing:2,marginBottom:8}}>{cur.l} SESSION EVENTS</div>
                        {cur.events.map((ev,i)=>(
                          <div key={i} style={{borderLeft:`3px solid ${ev.type==="yellow"?"#FFC906":ev.type==="battle"?"#FF8844":ev.type==="strategy"?"#BB66FF":ev.type==="surprise"?"#44CC88":"#4488FF"}`,padding:"9px 12px",marginBottom:6,background:"#161618",borderRadius:"0 4px 4px 0"}}>
                            <div style={{fontSize:13,lineHeight:1.6}}>{ev.icon} {ev.text}</div>
                          </div>
                        ))}
                      </div>
                    )}
                    <div style={{background:"#0F0F12",border:`1px solid ${cur.color}22`,borderLeft:`4px solid ${cur.color}`,borderRadius:"0 6px 6px 0",padding:"14px 16px"}}>
                      <div style={{fontSize:11,color:cur.color,fontWeight:700,letterSpacing:2,marginBottom:10}}>{cur.l} REPORT</div>
                      {cur.capFn().map((c,i)=>(
                        <p key={i} style={{fontSize:13,color:i===0?"#F0F0F0":"#aaa",lineHeight:1.8,marginBottom:8,whiteSpace:"pre-line"}}>{c}</p>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {/* Full qualifying report — shown on Q3 tab */}
              {qTab==="q3"&&(
                <div style={{marginTop:16,background:"#0F0F12",border:"1px solid #FFC90622",borderLeft:"4px solid #FFC906",borderRadius:"0 6px 6px 0",padding:"16px 20px"}}>
                  <div style={{fontSize:12,color:"#FFC906",fontWeight:700,letterSpacing:2,marginBottom:10}}>🎙 FULL QUALIFYING REPORT</div>
                  {buildQualifyingCaption(qual.q1,qual.q2,qual.q3,qual.grid,track).map((c,i)=>(
                    <p key={i} style={{fontSize:14,color:i===0?"#F0F0F0":"#aaa",lineHeight:1.85,marginBottom:i<5?10:0,whiteSpace:"pre-line"}}>{c}</p>
                  ))}
                </div>
              )}

              <div style={{display:"flex",gap:8,justifyContent:"flex-end",marginTop:16,flexWrap:"wrap"}}>
                {cur&&<button onClick={()=>{
                  const refSecs=QUAL_REFS[track.id]||null;
                  if(cur.kind==="fp"&&cur.data?.positions){
                    downloadLeaderboardPNG(track.name+" — "+cur.l,track.circuit+" · "+cur.sub+" · "+cur.dur,cur.data.positions,cur.color,"f1sim-"+track.id+"-"+cur.k+".png",{showLaps:true,refQualSecs:refSecs?refSecs+1.2:null});
                  }else if((cur.kind==="q"||cur.kind==="sq")&&cur.src){
                    const gs=cur.src.map((e,i)=>({...e,gap:i===0?null:((cur.src[0].score-e.score)*0.011).toFixed(3)}));
                    downloadLeaderboardPNG(track.name+" — "+cur.l,track.circuit+" · "+cur.sub+" · "+cur.dur,gs,cur.color,"f1sim-"+track.id+"-"+cur.k+".png",{refQualSecs:refSecs});
                  }
                }} style={{background:"#1E1E28",color:"#aaa",border:"1px solid #2A2A38",padding:"10px 16px",cursor:"pointer",fontFamily:"inherit",fontSize:13,fontWeight:700,letterSpacing:1,borderRadius:3}}>📷 PNG</button>}
                <button onClick={()=>exportWeekendCSV(track,{fp1,fp2,qual,sprintQual,sprint:null,race:null})} style={{background:"#1E1E28",color:"#aaa",border:"1px solid #2A2A38",padding:"10px 16px",cursor:"pointer",fontFamily:"inherit",fontSize:13,fontWeight:700,letterSpacing:1,borderRadius:3}}>📊 Export CSV</button>
                <button onClick={doQual} style={{background:"#2A2A30",color:"#ccc",border:"none",padding:"10px 20px",cursor:"pointer",fontFamily:"inherit",fontSize:14,fontWeight:700,letterSpacing:2.5,borderRadius:3}}>↺ RE-SIMULATE</button>
                {track.hasSprint&&<button onClick={doSprint} style={{background:"#FFC906",color:"#000",border:"none",padding:"10px 22px",cursor:"pointer",fontFamily:"inherit",fontSize:14,fontWeight:700,letterSpacing:2.5,borderRadius:3}}>⚡ RUN SPRINT →</button>}
                <button onClick={doRace} style={{background:"#E8002D",color:"#fff",border:"none",padding:"10px 24px",cursor:"pointer",fontFamily:"inherit",fontSize:16,fontWeight:700,letterSpacing:3,borderRadius:3}}>START RACE →</button>
              </div>
            </div>
          );}catch(e){return<div style={{padding:24,background:"#1A0808",border:"2px solid #E8002D",borderRadius:6,margin:8,fontFamily:"monospace"}}><div style={{color:"#E8002D",fontWeight:700,fontSize:16,marginBottom:8}}>⚠️ QUALIFYING VIEW ERROR — please report this</div><pre style={{color:"#FF8844",fontSize:12,whiteSpace:"pre-wrap"}}>{e&&e.stack?e.stack:String(e)}</pre></div>;}
        })()}


        {view==="sprint"&&sprint&&(
          <div style={{animation:"fadeIn 0.2s ease"}}>
            <div style={{marginBottom:14}}>
              <div style={{display:"flex",alignItems:"center",gap:10}}>
                <span style={{fontSize:26,fontWeight:700,letterSpacing:3}}>SPRINT RACE</span>
                  {sprint.runsUsed>1&&<span style={{background:"#FFC90618",color:"#FFC906",fontSize:12,fontWeight:700,padding:"2px 8px",borderRadius:2,letterSpacing:1}}>⟳ ×{sprint.runsUsed} RUNS AVERAGED</span>}
                <span style={{background:"#FFC90620",color:"#FFC906",fontSize:13,fontWeight:700,padding:"3px 8px",borderRadius:2,letterSpacing:1.5}}>⚡ {sprint.sprintLaps} LAPS</span>
              </div>
              <div style={{fontSize:14,color:"#778",letterSpacing:1.5,marginTop:2}}>{track.flag} {track.name} · Points for top 8: 8-7-6-5-4-3-2-1</div>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6,marginBottom:16}}>
              {(()=>{const _ss=new Set();return sprint.positions.filter(e=>{if(_ss.has(e.driver.id)) return false;_ss.add(e.driver.id);return true;}).slice(0,22);})().map((e,i)=>(
                <div key={e.driver.id} style={{display:"flex",alignItems:"center",gap:10,padding:"10px 14px",background:e.dnf?"#1A1010":i<3?"#181810":"#161618",border:`1px solid ${e.dnf?"#FF444418":i<3?"#FFC90618":"#1E1E22"}`,borderLeft:`3px solid ${e.dnf?"#FF4444":e.team.color}`,borderRadius:3,opacity:e.dnf?0.6:1}}>
                  <div style={{width:32,height:32,display:"flex",alignItems:"center",justifyContent:"center",background:i===0?"#FFC906":i===1?"#aaa":i===2?"#CD7F32":"transparent",color:i<3?"#000":"#bbb",fontSize:13,fontWeight:700,borderRadius:2,border:i>=3?"1px solid #2A2A30":"none",flexShrink:0}}>{e.dnf?"DNF":i+1}</div>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontSize:15,fontWeight:700,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{e.driver.name}</div>
                    <div style={{fontSize:12,color:e.team.color,letterSpacing:1.5}}>{e.team.name}</div>
                  </div>
                  <div style={{textAlign:"right",flexShrink:0}}>
                    {e.dnf?<div style={{fontSize:13,color:"#FF4444"}}>DNF L{e.dnfLap}</div>
                          :<><div style={{fontSize:14,fontFamily:"monospace",color:i===0?"#FFC906":"#aaa"}}>{i===0?"WIN":`+${e.gap}s`}</div>{e.points>0&&<div style={{fontSize:12,color:"#FFC906",fontWeight:700}}>+{e.points}pts</div>}</>}
                  </div>
                </div>
              ))}
            </div>
            <div style={{display:"flex",gap:8,justifyContent:"flex-end"}}>
              {/* Sprint story captions */}
              {(()=>{
                const caps=buildSprintCaption(sprint,qual,track);
                return(
                  <div style={{background:"#0F0F08",border:"1px solid #FFC90622",borderLeft:"4px solid #FFC906",borderRadius:"0 6px 6px 0",padding:"16px 20px",marginBottom:14}}>
                    <div style={{fontSize:12,color:"#FFC906",fontWeight:700,letterSpacing:2,marginBottom:10}}>⚡ SPRINT REPORT</div>
                    {caps.map((c,i)=><p key={i} style={{fontSize:14,color:i===0?"#F0F0F0":"#aaa",lineHeight:1.75,marginBottom:i<caps.length-1?8:0}}>{c}</p>)}
                  </div>
                );
              })()}
              <div style={{display:"flex",gap:8,justifyContent:"flex-end",flexWrap:"wrap"}}>
              <button onClick={()=>downloadLeaderboardPNG(track.name+" — SPRINT RACE",track.circuit+" · ⚡ "+sprint.sprintLaps+" LAPS · Points: 8-7-6-5-4-3-2-1",sprint.positions,"#FFC906","f1sim-"+track.id+"-sprint.png",{leaderLabel:"WIN",showPoints:true})} style={{background:"#1E1E28",color:"#aaa",border:"1px solid #2A2A38",padding:"10px 16px",cursor:"pointer",fontFamily:"inherit",fontSize:13,fontWeight:700,letterSpacing:1,borderRadius:3}}>📷 PNG</button>
              <button onClick={()=>exportWeekendCSV(track,{fp1,fp2,qual,sprintQual,sprint,race:null})} style={{background:"#1E1E28",color:"#aaa",border:"1px solid #2A2A38",padding:"10px 16px",cursor:"pointer",fontFamily:"inherit",fontSize:13,fontWeight:700,letterSpacing:1,borderRadius:3}}>📊 Export CSV</button>
              <button onClick={doSprint} style={{background:"#2A2A30",color:"#ccc",border:"none",padding:"10px 18px",cursor:"pointer",fontFamily:"inherit",fontSize:14,fontWeight:700,letterSpacing:2.5,borderRadius:3}}>↺ RE-RUN SPRINT</button>
              <button onClick={doRace} style={{background:"#E8002D",color:"#fff",border:"none",padding:"10px 24px",cursor:"pointer",fontFamily:"inherit",fontSize:16,fontWeight:700,letterSpacing:3,borderRadius:3}}>START GRAND PRIX →</button>
              </div>
            </div>
          </div>
        )}

        
        {view==="race"&&race&&(()=>{
          const TL=race.totalLaps||57;
          const QUARTERS=[
            {label:"Q1",sublabel:`Laps 1–${Math.floor(TL*0.25)}`,emoji:"🟢",color:"#44CC88",lapRange:[1,Math.floor(TL*0.25)]},
            {label:"Q2",sublabel:`Laps ${Math.floor(TL*0.25)+1}–${Math.floor(TL*0.5)}`,emoji:"🟡",color:"#FFC906",lapRange:[Math.floor(TL*0.25)+1,Math.floor(TL*0.5)]},
            {label:"Q3",sublabel:`Laps ${Math.floor(TL*0.5)+1}–${Math.floor(TL*0.75)}`,emoji:"🟠",color:"#FF8844",lapRange:[Math.floor(TL*0.5)+1,Math.floor(TL*0.75)]},
            {label:"FINAL",sublabel:`Laps ${Math.floor(TL*0.75)+1}–${TL} · Full Result`,emoji:"🏁",color:"#E8002D",lapRange:[Math.floor(TL*0.75)+1,TL]},
          ];
          const q=QUARTERS[raceQuarter];
          const isFinal=raceQuarter===3;
          const standings=isFinal?race.positions:((race.quarterStandings&&race.quarterStandings[raceQuarter])||race.positions);
          const leader=standings[0];
          const qEvents=race.events.filter(ev=>ev.lap>=q.lapRange[0]&&ev.lap<=q.lapRange[1]);
          return(
          <div style={{animation:"fadeIn 0.2s ease"}}>
            {/* Header */}
            <div style={{marginBottom:14}}>
              <div style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
                <div style={{fontSize:26,fontWeight:700,letterSpacing:3}}>GRAND PRIX — {track.name.toUpperCase()}</div>
                {race.runsUsed>1&&<span style={{background:"#E8002D18",color:"#E8002D",fontSize:12,fontWeight:700,padding:"2px 8px",borderRadius:2,letterSpacing:1}}>⟳ ×{race.runsUsed} RUNS</span>}
              </div>
              <div style={{display:"flex",gap:6,marginTop:6,flexWrap:"wrap"}}>
                {race.isWet&&<span style={{background:"#4488FF18",color:"#4488FF",fontSize:13,fontWeight:700,padding:"2px 7px",letterSpacing:1.5,borderRadius:2}}>🌧️ WET</span>}
                {race.hasSC&&<span style={{background:"#FFC90618",color:"#FFC906",fontSize:13,fontWeight:700,padding:"2px 7px",letterSpacing:1.5,borderRadius:2}}>🚗 SC LAP {race.scLap}</span>}
                {race.hasRF&&<span style={{background:"#FF000022",color:"#FF4444",fontSize:13,fontWeight:700,padding:"2px 7px",letterSpacing:1.5,borderRadius:2}}>🔴 RED FLAG LAP {race.rfLap} · RESUME {race.rfResumeLap}</span>}
                {race.fastestLap&&<span style={{background:"#CC44FF18",color:"#CC44FF",fontSize:13,fontWeight:700,padding:"2px 7px",letterSpacing:1.5,borderRadius:2}}>💜 FL: {race.fastestLap.name}</span>}
                {raceSaved&&<span style={{background:"#44CC8818",color:"#44CC88",fontSize:13,fontWeight:700,padding:"2px 7px",letterSpacing:1.5,borderRadius:2}}>✓ SAVED</span>}
              </div>
              {race.fastestLap&&race.fastestLapSectors&&(
                <div style={{fontSize:12,fontFamily:"monospace",color:"#889",marginTop:6,letterSpacing:0.5}}>
                  {(()=>{const m=Math.floor(race.fastestLapSeconds/60);return m+":"+(race.fastestLapSeconds%60).toFixed(3).padStart(6,"0");})()}
                  {" — "}
                  {race.fastestLapSectors.map((s,si)=>"S"+(si+1)+" "+s.toFixed(3)).join(" · ")}
                </div>
              )}
            </div>

            {/* Quarter tab bar */}
            <div style={{display:"flex",gap:4,marginBottom:16,background:"#111118",border:"1px solid #1E1E22",borderRadius:6,padding:5}}>
              {QUARTERS.map((qt,qi)=>{
                const qWeather=race.quarterWeather&&race.quarterWeather[qi];
                const wxBadge=qWeather&&qWeather.rf?"🔴":qWeather&&qWeather.wet?"🌧️":qWeather&&qWeather.sc?"🚗":"";
                return(
                <button key={qi} onClick={()=>setRaceQuarter(qi)} style={{flex:1,background:raceQuarter===qi?`${qt.color}20`:"transparent",color:raceQuarter===qi?qt.color:"#778",border:`1px solid ${raceQuarter===qi?qt.color+"55":"transparent"}`,padding:"8px 6px",cursor:"pointer",fontFamily:"inherit",fontSize:13,fontWeight:700,letterSpacing:1.5,borderRadius:4,transition:"all 0.15s",textAlign:"center"}}>
                  <div>{qt.emoji} {qt.label} {wxBadge}</div>
                  <div style={{fontSize:10,fontWeight:400,opacity:0.7,marginTop:2,letterSpacing:0.5}}>{qt.sublabel}</div>
                </button>
                );
              })}
            </div>

            {/* Quarter weather strip */}
            {(()=>{
              const qWeather=race.quarterWeather&&race.quarterWeather[raceQuarter];
              const isWetQ=qWeather&&qWeather.wet;
              const hasSCQ=qWeather&&qWeather.sc;
              const hasRFQ=qWeather&&qWeather.rf;
              if(!isWetQ&&!hasSCQ&&!hasRFQ) return null;
              return(
                <div style={{display:"flex",gap:8,marginBottom:10,flexWrap:"wrap"}}>
                  {hasRFQ&&<span style={{background:"#FF000022",color:"#FF4444",fontSize:13,fontWeight:700,padding:"4px 10px",letterSpacing:1.5,borderRadius:3,border:"1px solid #FF000044"}}>🔴 RED FLAG · RACE SUSPENDED · {q.label}</span>}
                  {isWetQ&&<span style={{background:"#4488FF18",color:"#4488FF",fontSize:13,fontWeight:700,padding:"4px 10px",letterSpacing:1.5,borderRadius:3,border:"1px solid #4488FF33"}}>🌧️ WET CONDITIONS · {q.label}</span>}
                  {hasSCQ&&<span style={{background:"#FFC90618",color:"#FFC906",fontSize:13,fontWeight:700,padding:"4px 10px",letterSpacing:1.5,borderRadius:3,border:"1px solid #FFC90633"}}>🚗 SAFETY CAR PERIOD · {q.label}</span>}
                  {isWetQ&&<span style={{background:"#FF444418",color:"#FF8888",fontSize:12,fontWeight:700,padding:"4px 10px",letterSpacing:1,borderRadius:3,border:"1px solid #FF444422"}}>⚠️ Incident risk elevated</span>}
                  {hasRFQ&&<span style={{background:"#FF000018",color:"#FF8888",fontSize:12,fontWeight:700,padding:"4px 10px",letterSpacing:1,borderRadius:3,border:"1px solid #FF000022"}}>🏎️ Free tyre changes for all</span>}
                </div>
              );
            })()}

            {/* Leader banner */}
            {leader&&(
              <div style={{background:`${q.color}12`,border:`1px solid ${q.color}33`,borderLeft:`5px solid ${q.color}`,borderRadius:"0 8px 8px 0",padding:"12px 18px",marginBottom:14,display:"flex",alignItems:"center",gap:14}}>
                <span style={{fontSize:28}}>{q.emoji}</span>
                <div style={{flex:1}}>
                  <div style={{fontSize:11,color:q.color,fontWeight:700,letterSpacing:2,marginBottom:2}}>{isFinal?"RACE WINNER":"LEADING AFTER "+q.label}</div>
                  <div style={{fontSize:isFinal?22:18,fontWeight:700}}>{leader.driver?.name||leader.driverName}</div>
                  <div style={{fontSize:13,color:(leader.team||leader).color||"#aaa",letterSpacing:1.5}}>{leader.team?.name||leader.teamName}</div>
                </div>
                {isFinal&&<div style={{textAlign:"right"}}>
                  <div style={{fontSize:32}}>🏆</div>
                  <div style={{fontSize:13,color:"#FFC906",fontWeight:700}}>+{race.positions[0]?.points||25} PTS</div>
                </div>}
              </div>
            )}

            <div style={{display:"grid",gridTemplateColumns:"1fr 360px",gap:18,alignItems:"start"}}>
              {/* Standings */}
              <div>
                <div style={{fontSize:12,color:"#778",letterSpacing:2.5,marginBottom:8}}>{isFinal?"FINAL CLASSIFICATION":"STANDINGS AFTER "+q.label+" · "+q.sublabel}</div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:5}}>
                  {standings.map((e,i)=>{
                    const dName=e.driver?.name||e.driverName||"";
                    const tColor=e.team?.color||e.teamColor||"#aaa";
                    const tName=e.team?.name||e.teamName||"";
                    const isDNF=e.dnf;
                    const posChg=isFinal?(e.gridPos-(i+1)):null;
                    return(
                    <div key={dName+i} style={{display:"flex",alignItems:"center",gap:9,padding:"9px 12px",background:isDNF?"#1A1010":i<3?"#181810":"#161618",border:`1px solid ${isDNF?"#FF444418":i<3?q.color+"22":"#1E1E22"}`,borderLeft:`3px solid ${isDNF?"#FF4444":tColor}`,borderRadius:3,opacity:isDNF?0.65:1}}>
                      <div style={{width:28,height:28,display:"flex",alignItems:"center",justifyContent:"center",background:i===0?q.color:i===1?"#aaa":i===2?"#CD7F32":"transparent",color:i<3?"#000":"#bbb",fontSize:12,fontWeight:700,borderRadius:2,border:i>=3?"1px solid #2A2A30":"none",flexShrink:0}}>{isDNF?"DNF":i+1}</div>
                      <div style={{flex:1,minWidth:0}}>
                        <div style={{fontSize:13,fontWeight:700,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{e.driver?.flag||""} {dName}</div>
                        <div style={{fontSize:11,color:tColor,letterSpacing:1}}>{tName}</div>
                      </div>
                      <div style={{textAlign:"right",flexShrink:0}}>
                        {isDNF?<>
                            <div style={{fontSize:11,color:"#FF4444"}}>L{e.dnfLap||"?"}</div>
                            {e.dnfReason&&<div style={{fontSize:10,color:"#FF6644",maxWidth:90,textAlign:"right",lineHeight:1.3}}>{e.dnfReason}</div>}
                          </>
                          :<>
                            <div style={{fontSize:12,fontFamily:"monospace",color:i===0?q.color:"#aaa"}}>{i===0?(isFinal?"🏁 WIN":"P1"):`+${e.gap}s`}</div>
                            {e.timePenalty&&<div style={{fontSize:10,color:"#FF8800",fontWeight:700}}>+{e.timePenalty}s PEN</div>}
                            {isFinal&&e.points>0&&<div style={{fontSize:11,color:"#E8002D",fontWeight:700}}>+{e.points}pts</div>}
                            {isFinal&&posChg!==null&&posChg!==0&&<div style={{fontSize:10,color:posChg>0?"#44CC88":"#FF6644"}}>{posChg>0?`▲${posChg}`:`▼${Math.abs(posChg)}`}</div>}
                          </>}
                      </div>
                    </div>
                  );})}
                </div>
              </div>

              {/* Events for this quarter */}
              <div style={{position:"sticky",top:16}}>
                <div style={{fontSize:12,color:"#778",letterSpacing:2.5,marginBottom:8}}>EVENTS · {q.label} ({qEvents.length})</div>
                <div style={{maxHeight:"calc(100vh - 220px)",overflowY:"auto"}}>
                  {qEvents.length===0&&<div style={{fontSize:13,color:"#445",padding:"16px 0",textAlign:"center"}}>No events this quarter.</div>}
                  {qEvents.map((ev,i)=>(
                    <div key={i} style={{borderLeft:`3px solid ${EVT_C[ev.type]||"#899"}`,padding:"8px 12px",marginBottom:5,background:"#161618",borderRadius:"0 4px 4px 0"}}>
                      <div style={{fontSize:11,color:"#778",letterSpacing:1.5,marginBottom:2}}>LAP {ev.lap}</div>
                      <div style={{fontSize:13,lineHeight:1.55}}>{ev.icon} {ev.text}</div>
                    </div>
                  ))}
                </div>
                {/* quarter nav */}
                <div style={{display:"flex",gap:6,marginTop:10}}>
                  {raceQuarter>0&&<button onClick={()=>setRaceQuarter(raceQuarter-1)} style={{flex:1,background:"#1E1E22",color:"#aaa",border:"none",padding:"8px",cursor:"pointer",fontFamily:"inherit",fontSize:13,fontWeight:700,borderRadius:3}}>← {QUARTERS[raceQuarter-1].label}</button>}
                  {raceQuarter<3&&<button onClick={()=>setRaceQuarter(raceQuarter+1)} style={{flex:1,background:q.color,color:"#000",border:"none",padding:"8px",cursor:"pointer",fontFamily:"inherit",fontSize:13,fontWeight:700,borderRadius:3}}>{QUARTERS[raceQuarter+1].label} →</button>}
                </div>
              </div>
            </div>

            <div style={{marginTop:16,display:"flex",gap:8,justifyContent:"flex-end",flexWrap:"wrap"}}>
              <button onClick={()=>{
                const lbl=isFinal?"FINAL CLASSIFICATION":"STANDINGS AFTER "+q.label;
                const fn="f1sim-"+track.id+"-race"+(isFinal?"":"-"+q.label.toLowerCase())+".png";
                downloadLeaderboardPNG(track.name+" — "+lbl,track.circuit+" · "+race.totalLaps+" LAPS",standings,q.color,fn,{showPoints:isFinal,leaderLabel:isFinal?"🏆 WIN":"P1"});
              }} style={{background:"#1E1E28",color:"#aaa",border:"1px solid #2A2A38",padding:"10px 16px",cursor:"pointer",fontFamily:"inherit",fontSize:13,fontWeight:700,letterSpacing:1,borderRadius:3}}>📷 PNG</button>
              <button onClick={()=>exportWeekendCSV(track,{fp1,fp2,qual,sprintQual,sprint,race})} style={{background:"#1E1E28",color:"#aaa",border:"1px solid #2A2A38",padding:"10px 16px",cursor:"pointer",fontFamily:"inherit",fontSize:13,fontWeight:700,letterSpacing:1,borderRadius:3}}>📊 Export CSV</button>
              <button onClick={doRace} style={{background:"#2A2A30",color:"#ccc",border:"none",padding:"10px 18px",cursor:"pointer",fontFamily:"inherit",fontSize:14,fontWeight:700,letterSpacing:2.5,borderRadius:3}}>↺ RE-RUN</button>
              <button onClick={saveToChampionship} disabled={raceSaved} style={{background:raceSaved?"#1A2A1A":"#44CC88",color:raceSaved?"#44CC88":"#000",border:`1px solid ${raceSaved?"#44CC8844":"transparent"}`,padding:"10px 18px",cursor:raceSaved?"default":"pointer",fontFamily:"inherit",fontSize:14,fontWeight:700,letterSpacing:1.5,borderRadius:3,opacity:raceSaved?0.7:1}}>
                {raceSaved ? (dbSaving ? "⟳ SYNCING DB…" : "✓ SAVED") : "💾 SAVE TO CHAMPIONSHIP"}
              </button>
              <button onClick={()=>{setView("commentary");if(race&&!isGen)doCommentary();}} style={{background:"#CC44FF",color:"#fff",border:"none",padding:"10px 24px",cursor:"pointer",fontFamily:"inherit",fontSize:15,fontWeight:700,letterSpacing:2.5,borderRadius:3}}>🎙️ CROFT & BRUNDLE →</button>
            </div>
          </div>
          );
        })()}

        
        {view==="commentary"&&(
          <div style={{animation:"fadeIn 0.2s ease"}}>
            {/* API key banner — shown when no key is stored */}
            {!apiKey&&(
              <div style={{background:"#18140A",border:"1px solid #FFC90644",borderLeft:"4px solid #FFC906",borderRadius:"0 6px 6px 0",padding:"14px 18px",marginBottom:16}}>
                <div style={{fontSize:14,color:"#FFC906",fontWeight:700,marginBottom:6,letterSpacing:1.5}}>🔑 API KEY REQUIRED FOR AI COMMENTARY</div>
                <div style={{fontSize:13,color:"#899",marginBottom:10}}>Enter your Anthropic API key to enable Croft &amp; Brundle. Get one free at console.anthropic.com</div>
                <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                  <input type="password" placeholder="sk-ant-api03-..." value={apiKeyInput||""} onChange={e=>setApiKeyInput(e.target.value)}
                    style={{flex:1,minWidth:220,background:"#0C0C0F",border:"1px solid #555",color:"#F0F0F0",padding:"8px 12px",fontFamily:"inherit",fontSize:14,borderRadius:3}}/>
                  <button onClick={()=>saveApiKey()} style={{background:"#FFC906",color:"#000",border:"none",padding:"8px 18px",cursor:"pointer",fontFamily:"inherit",fontSize:13,fontWeight:700,letterSpacing:1.5,borderRadius:3}}>SAVE KEY</button>
                </div>
                <div style={{fontSize:11,color:"#555",marginTop:6}}>Stored in your browser only. Sent only to Anthropic API.</div>
              </div>
            )}
            {apiKey&&(
              <div style={{display:"flex",justifyContent:"flex-end",marginBottom:4}}>
                <button onClick={()=>clearApiKey()} style={{background:"none",border:"none",color:"#555",cursor:"pointer",fontFamily:"inherit",fontSize:12,letterSpacing:1}}>× CLEAR KEY</button>
              </div>
            )}
            <div style={{marginBottom:16}}>
              <div style={{fontSize:26,fontWeight:700,letterSpacing:3}}>CROFT & BRUNDLE</div>
              <div style={{display:"flex",gap:14,marginTop:8,alignItems:"center",flexWrap:"wrap"}}>
                {[{l:"DC",n:"DAVID CROFT",sub:"Play-by-play",c:"#E8002D",bg:"#E8002D22"},{l:"MB",n:"MARTIN BRUNDLE",sub:"Colour commentary",c:"#4466AA",bg:"#08081A"}].map(x=>(
                  <div key={x.l} style={{display:"flex",alignItems:"center",gap:8}}>
                    <div style={{width:32,height:32,borderRadius:"50%",background:x.bg,border:`2px solid ${x.c}`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:13,fontWeight:900,color:x.c}}>{x.l}</div>
                    <div><div style={{fontSize:14,fontWeight:700,color:x.c,letterSpacing:1.5}}>{x.n}</div><div style={{fontSize:12,color:"#899"}}>{x.sub}</div></div>
                  </div>
                ))}
                <div style={{marginLeft:"auto",fontSize:13,color:"#778"}}>{track.flag} {track.name.toUpperCase()}</div>
              </div>
            </div>

            {isGen&&(
              <div style={{background:"#111115",border:"1px solid #1E1E22",borderRadius:8,padding:50,textAlign:"center"}}>
                <div style={{display:"flex",justifyContent:"center",gap:20,marginBottom:22}}>
                  {[{l:"DC",c:"#E8002D",d:1.2},{l:"MB",c:"#4466AA",d:1.5}].map(x=>(
                    <div key={x.l} style={{display:"flex",flexDirection:"column",alignItems:"center",gap:6}}>
                      <div style={{width:44,height:44,borderRadius:"50%",background:x.l==="DC"?"#E8002D22":"#08081A",border:`2px solid ${x.c}`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:16,fontWeight:900,color:x.c,animation:`pulse ${x.d}s ease-in-out infinite`}}>{x.l}</div>
                      <div style={{fontSize:12,color:x.c,letterSpacing:1.5}}>{x.l==="DC"?"CROFT":"BRUNDLE"}</div>
                    </div>
                  ))}
                </div>
                <div style={{fontSize:17,fontWeight:700,color:"#CC44FF",letterSpacing:2.5,animation:"pulse 1.3s ease-in-out infinite",marginBottom:8}}>{genMsg||"GENERATING BROADCAST…"}</div>
                <div style={{fontSize:14,color:"#778",letterSpacing:1.5}}>LAP-BY-LAP DIALOGUE · ALL 22 DRIVERS · 7 STAGES</div>
              </div>
            )}

            {stages&&!isGen&&(()=>{
              const s=STAGE_DEFS[activeS];
              const sd=stages.find(x=>x.key===s.key);
              const lines=sd?.lines||[];
              return(
                <>
                  <div style={{display:"flex",gap:3,marginBottom:16,flexWrap:"wrap",background:"#111115",border:"1px solid #1E1E22",borderRadius:5,padding:5}}>
                    {STAGE_DEFS.map((st,i)=>{
                      const sd2=stages.find(x=>x.key===st.key);
                      if(!sd2) return null;
                      return(
                        <button key={st.key} onClick={()=>setActiveS(i)} style={{flex:"0 0 auto",background:activeS===i?`${st.color}20`:"transparent",color:activeS===i?st.color:"#899",border:`1px solid ${activeS===i?st.color+"55":"transparent"}`,padding:"6px 10px",cursor:"pointer",fontFamily:"inherit",fontSize:13,fontWeight:700,letterSpacing:1.5,borderRadius:3,transition:"all 0.15s",whiteSpace:"nowrap"}}>
                          {st.emoji} {st.title} <span style={{opacity:0.5,fontSize:12}}>{sd2.lines?.length||0}</span>
                        </button>
                      );
                    })}
                  </div>

                  <div key={activeS} style={{animation:"slideIn 0.22s ease"}}>
                    <div style={{background:`${s.color}0D`,border:`1px solid ${s.color}33`,borderLeft:`5px solid ${s.color}`,borderRadius:"0 8px 8px 0",padding:"13px 18px",marginBottom:16,display:"flex",alignItems:"center",gap:12,justifyContent:"space-between"}}>
                      <div style={{display:"flex",alignItems:"center",gap:12}}>
                        <span style={{fontSize:30}}>{s.emoji}</span>
                        <div>
                          <div style={{fontSize:20,fontWeight:700,color:s.color,letterSpacing:2.5}}>{s.title}</div>
                          <div style={{fontSize:13,color:"#899",marginTop:2}}>{s.lapHint} · {lines.length} EXCHANGES</div>
                        </div>
                      </div>
                      <button onClick={()=>downloadStage(lines,s,track)} title="Download as image"
                        style={{background:`${s.color}20`,color:s.color,border:`1px solid ${s.color}44`,padding:"7px 14px",cursor:"pointer",fontFamily:"inherit",fontSize:14,fontWeight:700,letterSpacing:1.5,borderRadius:3,flexShrink:0}}>
                        ⬇ DOWNLOAD PNG
                      </button>
                    </div>
                    <div style={{background:"#0D0D10",border:"1px solid #1A1A20",borderRadius:8,padding:"18px 18px 4px"}}>
                      {lines.map((line,li)=><DialogueLine key={li} speaker={line.speaker} text={line.text} surnameMap={surnameMap}/>)}
                    </div>
                  </div>

                  <div style={{marginTop:14,display:"grid",gridTemplateColumns:"repeat(7,1fr)",gap:4}}>
                    {STAGE_DEFS.map((st,i)=>{
                      if(!stages.find(x=>x.key===st.key)) return null;
                      return <div key={i} onClick={()=>setActiveS(i)} style={{background:activeS===i?`${st.color}15`:"#161618",border:`1px solid ${activeS===i?st.color+"44":"#222"}`,borderTop:`2px solid ${st.color}`,borderRadius:3,padding:"7px 3px",cursor:"pointer",textAlign:"center",transition:"all 0.15s"}}>
                        <div style={{fontSize:17}}>{st.emoji}</div>
                        <div style={{fontSize:10,color:activeS===i?st.color:"#778",fontWeight:700,letterSpacing:0.3,marginTop:2,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{st.title}</div>
                      </div>;
                    })}
                  </div>

                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginTop:12}}>
                    <button onClick={()=>setActiveS(a=>Math.max(0,a-1))} disabled={activeS===0} style={{background:"#2A2A30",color:activeS===0?"#2A2A30":"#ccc",border:"none",padding:"9px 18px",cursor:activeS===0?"default":"pointer",fontFamily:"inherit",fontSize:14,fontWeight:700,letterSpacing:1.5,borderRadius:3,opacity:activeS===0?0.3:1}}>← PREV</button>
                    <div style={{display:"flex",gap:5}}>{STAGE_DEFS.map((_,i)=><div key={i} onClick={()=>setActiveS(i)} style={{width:i===activeS?22:7,height:7,borderRadius:4,background:i===activeS?STAGE_DEFS[activeS].color:"#2A2A30",cursor:"pointer",transition:"all 0.2s"}}/>)}</div>
                    <button onClick={()=>setActiveS(a=>Math.min(STAGE_DEFS.length-1,a+1))} disabled={activeS===STAGE_DEFS.length-1} style={{background:STAGE_DEFS[Math.min(activeS+1,STAGE_DEFS.length-1)].color,color:"#fff",border:"none",padding:"9px 18px",cursor:activeS===STAGE_DEFS.length-1?"default":"pointer",fontFamily:"inherit",fontSize:14,fontWeight:700,letterSpacing:1.5,borderRadius:3,opacity:activeS===STAGE_DEFS.length-1?0.3:1}}>NEXT →</button>
                  </div>

                  <div style={{display:"flex",gap:8,justifyContent:"flex-end",marginTop:12}}>
                    <button onClick={doCommentary} style={{background:"#2A2A30",color:"#ccc",border:"none",padding:"9px 18px",cursor:"pointer",fontFamily:"inherit",fontSize:14,fontWeight:700,letterSpacing:1.5,borderRadius:3}}>↺ REGENERATE</button>
                    <button onClick={()=>{setView("tracks");setQual(null);setSprint(null);setRace(null);setStages(null);setFp1(null);setFp2(null);setSprintQual(null);setRaceSaved(false);setDbSaving(false);}} style={{background:"#E8002D",color:"#fff",border:"none",padding:"9px 22px",cursor:"pointer",fontFamily:"inherit",fontSize:15,fontWeight:700,letterSpacing:2.5,borderRadius:3}}>NEW RACE →</button>
                  </div>
                </>
              );
            })()}

            {!stages&&!isGen&&(
              <div style={{background:"#111115",border:"1px solid #1E1E22",borderRadius:8,padding:"40px 30px",textAlign:"center"}}>
                {!race?(
                  <div style={{fontSize:14,color:"#778",letterSpacing:1.5}}>Complete a race first, then come back here to generate commentary.</div>
                ):!apiKey?(
                  <div style={{fontSize:14,color:"#778"}}>Enter your API key above to enable commentary generation.</div>
                ):(
                  <>
                    <div style={{fontSize:28,marginBottom:14}}>🎙️</div>
                    <div style={{fontSize:18,fontWeight:700,letterSpacing:2,marginBottom:8}}>READY TO BROADCAST</div>
                    <div style={{fontSize:14,color:"#778",marginBottom:22,letterSpacing:1}}>
                      {track.flag} {track.name} · {race.positions[0]?.driver.name} wins · {race.totalLaps} laps
                    </div>
                    <button onClick={doCommentary} style={{background:"#CC44FF",color:"#fff",border:"none",padding:"13px 36px",cursor:"pointer",fontFamily:"inherit",fontSize:16,fontWeight:700,letterSpacing:2.5,borderRadius:4}}>
                      ▶ GENERATE CROFT & BRUNDLE
                    </button>
                    <div style={{fontSize:12,color:"#555",marginTop:12}}>7 stages · lap-by-lap dialogue · all 22 drivers</div>
                  </>
                )}
              </div>
            )}
          </div>
        )}

        
        {view==="testing"&&(
          <div style={{animation:"fadeIn 0.2s ease"}}>
            <div style={{marginBottom:18}}>
              <div style={{fontSize:26,fontWeight:700,letterSpacing:3}}>🔬 2027 PRE-SEASON TESTING</div>
              <div style={{fontSize:14,color:"#778",marginTop:4,letterSpacing:1.5}}>Barcelona · Feb 10–12 &nbsp;|&nbsp; Bahrain · Feb 24–26</div>
            </div>

            {/* Session selector */}
            <div style={{display:"flex",gap:8,marginBottom:18}}>
              {TESTING_SESSIONS.map(s=>(
                <button key={s.id} onClick={()=>{setTestTab(s.id);doTest(s);}}
                  style={{background:testTab===s.id?"#1E1E2A":"transparent",color:testTab===s.id?"#F0F0F0":"#778",border:`1px solid ${testTab===s.id?"#4444AA":"#2A2A30"}`,padding:"10px 20px",cursor:"pointer",fontFamily:"inherit",fontSize:14,fontWeight:700,letterSpacing:1.5,borderRadius:3,transition:"all 0.15s"}}>
                  {s.flag} {s.name.replace("Pre-Season Test","Test")}
                  <span style={{fontSize:11,color:"#555",marginLeft:6}}>{s.dates}</span>
                </button>
              ))}
            </div>

            {testResults&&testSession&&(()=>{
              const {days:dayData, overall} = testResults;
              const activeDay = testDay === 0 ? null : dayData.find(d=>d.day===testDay);
              const displayResults = activeDay ? activeDay.results : overall;
              const fastest = displayResults[0];

              // Build day tab caption
              const dayCaps = activeDay
                ? buildDayCaption(activeDay, testSession, activeDay.day-1, testSession.days)
                : buildTestingCaption(overall, testSession);

              return(
                <>
                  {/* Day selector tabs */}
                  <div style={{display:"flex",gap:4,marginBottom:16,background:"#0D0D10",border:"1px solid #1E1E22",borderRadius:5,padding:5}}>
                    {/* Day tabs */}
                    {dayData.map(d=>(
                      <button key={d.day} onClick={()=>setTestDay(d.day)}
                        style={{flex:1,background:testDay===d.day?"#1A1A28":"transparent",color:testDay===d.day?"#6688FF":"#778",border:`1px solid ${testDay===d.day?"#4444AA":"transparent"}`,padding:"9px 4px",cursor:"pointer",fontFamily:"inherit",fontSize:13,fontWeight:700,letterSpacing:1,borderRadius:3,transition:"all 0.15s"}}>
                        <div>DAY {d.day}</div>
                        <div style={{fontSize:10,color:testDay===d.day?d.conditions.icon?"#aaa":"#6688FF":"#555",marginTop:2}}>{d.conditions.icon} {d.char.label.split("&")[0].trim()}</div>
                      </button>
                    ))}
                    {/* Overall divider + tab */}
                    <div style={{width:1,background:"#2A2A30",margin:"4px 2px"}}/>
                    <button onClick={()=>setTestDay(0)}
                      style={{flex:1,background:testDay===0?"#161A16":"transparent",color:testDay===0?"#44CC88":"#778",border:`1px solid ${testDay===0?"#44CC8844":"transparent"}`,padding:"9px 4px",cursor:"pointer",fontFamily:"inherit",fontSize:13,fontWeight:700,letterSpacing:1,borderRadius:3,transition:"all 0.15s"}}>
                      <div>OVERALL</div>
                      <div style={{fontSize:10,color:testDay===0?"#44CC88":"#555",marginTop:2}}>Best of {testSession.days}</div>
                    </button>
                  </div>

                  {/* Caption panel */}
                  <div style={{background:"#0D0D14",border:"1px solid #2A2A40",borderLeft:`4px solid ${testDay===0?"#44CC88":"#4466FF"}`,borderRadius:"0 6px 6px 0",padding:"18px 22px",marginBottom:18}}>
                    <div style={{fontSize:12,color:testDay===0?"#44CC88":"#6688FF",fontWeight:700,letterSpacing:2,marginBottom:12}}>
                      {testDay===0?`🔬 ${testSession.days}-DAY TEST — OVERALL SUMMARY`:`🔬 DAY ${testDay} REPORT — ${activeDay?.conditions.icon} ${activeDay?.conditions.label.toUpperCase()}`}
                    </div>
                    {dayCaps.map((c,i)=>(
                      <p key={i} style={{fontSize:14,color:i===0?"#F0F0F0":"#aaa",lineHeight:1.85,marginBottom:i<dayCaps.length-1?12:0,whiteSpace:"pre-line"}}>{c}</p>
                    ))}
                  </div>

                  {/* Incident log for active day */}
                  {activeDay&&activeDay.incidents.length>0&&(
                    <div style={{marginBottom:14}}>
                      <div style={{fontSize:12,color:"#FF8844",fontWeight:700,letterSpacing:2,marginBottom:8}}>⚠️ DAY {testDay} INCIDENTS ({activeDay.incidents.length})</div>
                      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(300px,1fr))",gap:6}}>
                        {activeDay.incidents.map((inc,i)=>(
                          <div key={i} style={{background:"#1A1208",border:`1px solid ${inc.issue.severity==="Major"?"#FF444444":"#FF884422"}`,borderLeft:`3px solid ${inc.issue.severity==="Major"?"#FF4444":"#FF8844"}`,borderRadius:3,padding:"9px 13px"}}>
                            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4}}>
                              <span style={{fontSize:13,fontWeight:700,color:"#F0F0F0"}}>{inc.driver.name}</span>
                              <span style={{fontSize:10,background:inc.issue.severity==="Major"?"#FF444420":"#FF884420",color:inc.issue.severity==="Major"?"#FF4444":"#FF8844",padding:"2px 7px",borderRadius:2,fontWeight:700}}>{inc.issue.severity.toUpperCase()}</span>
                            </div>
                            <div style={{fontSize:12,color:inc.team.color,marginBottom:4}}>{inc.team.name}</div>
                            <div style={{fontSize:12,color:"#aaa"}}>{inc.issue.type} — {inc.issue.session} session</div>
                            <div style={{fontSize:11,color:"#778",marginTop:2}}>~{inc.issue.lapLost} laps lost</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Timing sheet */}
                  <div style={{background:"#111115",border:"1px solid #1E1E22",borderRadius:6,overflow:"hidden",marginBottom:12}}>
                    <div style={{display:"grid",gridTemplateColumns:"36px 1fr 110px 110px 80px 1fr",background:"#0D0D10",padding:"10px 16px",borderBottom:"1px solid #1E1E22",gap:8}}>
                      {["#","DRIVER",activeDay?"BEST LAP (TODAY)":"BEST LAP",activeDay?"RACE SIM":"RACE SIM","LAPS",activeDay?"TODAY'S PROGRAMME":"ISSUES"].map(h=>(
                        <div key={h} style={{fontSize:11,color:"#778",fontWeight:700,letterSpacing:1.5,textAlign:h==="DRIVER"?"left":"right"}}>{h}</div>
                      ))}
                    </div>
                    {displayResults.map((r,i)=>{
                      const rLap=r.bestLap??r.qualiSim;
                      const fLap=fastest.bestLap??fastest.qualiSim;
                      const gap = i===0 ? null : (rLap - fLap);
                      const prog = activeDay
                        ? [r.didQualiRun?"🏎 Q-sim":"",r.didLongRun?"📏 Long run":"",!r.didQualiRun&&!r.didLongRun?"🔧 Install/setup":""].filter(Boolean).join("  ")
                        : null;
                      const issuesDisplay = !activeDay && r.issues?.length
                        ? r.issues.map((iss,j)=>(
                            <span key={j} style={{display:"inline-block",background:"#FF884420",color:"#FF8844",padding:"2px 6px",borderRadius:2,marginRight:3,fontSize:10}}>D{iss.day}: {iss.type}</span>
                          ))
                        : null;
                      return(
                        <div key={r.driver.id} style={{display:"grid",gridTemplateColumns:"36px 1fr 110px 110px 80px 1fr",gap:8,padding:"9px 16px",borderBottom:"1px solid #161618",background:i===0?"#161620":i<3?"#141414":"#111115",alignItems:"center"}}>
                          <div style={{fontSize:14,fontWeight:700,color:i===0?"#6688FF":i<3?"#aaa":"#778"}}>{i+1}</div>
                          <div style={{display:"flex",alignItems:"center",gap:8}}>
                            <div style={{width:3,height:28,background:r.team.color,borderRadius:2,flexShrink:0}}/>
                            <div>
                              <div style={{fontSize:14,fontWeight:700}}>{r.driver.flag} {r.driver.name}</div>
                              <div style={{fontSize:12,color:r.team.color}}>{r.team.name}</div>
                            </div>
                          </div>
                          <div style={{textAlign:"right"}}>
                            <div style={{fontSize:14,fontFamily:"monospace",fontWeight:700,color:i===0?"#6688FF":"#F0F0F0"}}>{fmtLap(rLap)}</div>
                            {gap&&<div style={{fontSize:11,color:"#778"}}>+{gap.toFixed(3)}s</div>}
                          </div>
                          <div style={{textAlign:"right"}}>
                            {r.longRun
                              ?<><div style={{fontSize:14,fontFamily:"monospace",color:"#aaa"}}>{fmtLap(r.longRun)}</div><div style={{fontSize:10,color:"#555"}}>race sim</div></>
                              :<div style={{fontSize:12,color:"#555"}}>—</div>}
                          </div>
                          <div style={{textAlign:"right"}}>
                            <div style={{fontSize:14,fontWeight:700,color:r.laps>40?"#44CC88":r.laps<15?"#FF8844":"#F0F0F0"}}>{r.laps}</div>
                          </div>
                          <div style={{fontSize:11}}>
                            {activeDay
                              ?<span style={{color:r.issue?"#FF8844":"#778"}}>{prog}{r.issue?<span style={{marginLeft:6,background:"#FF884420",color:"#FF8844",padding:"1px 5px",borderRadius:2}}>⚠️ {r.issue.type}</span>:""}</span>
                              :issuesDisplay||<span style={{color:"#2A2A30"}}>—</span>}
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {/* Long run pace bars — only on overall or days with long run data */}
                  {(()=>{
                    const lr = displayResults.filter(r=>r.longRun);
                    if(!lr.length) return null;
                    const range = lr[lr.length-1].longRun - lr[0].longRun || 1;
                    return(
                      <div style={{marginBottom:16}}>
                        <div style={{fontSize:12,color:"#778",letterSpacing:2,marginBottom:8,fontWeight:700}}>RACE PACE COMPARISON — {activeDay?`DAY ${testDay}`:"OVERALL"}</div>
                        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(260px,1fr))",gap:5}}>
                          {lr.slice(0,12).map((r,i)=>{
                            const pct = Math.max(8, 100-((r.longRun-lr[0].longRun)/range)*100);
                            return(
                              <div key={r.driver.id} style={{display:"flex",alignItems:"center",gap:8,padding:"6px 10px",background:"#161618",borderRadius:3}}>
                                <div style={{width:3,height:22,background:r.team.color,borderRadius:2,flexShrink:0}}/>
                                <div style={{fontSize:12,fontWeight:700,minWidth:95}}>{r.driver.name.split(" ").pop()}</div>
                                <div style={{flex:1,height:6,background:"#1E1E22",borderRadius:3}}>
                                  <div style={{height:6,width:`${pct}%`,background:r.team.color,borderRadius:3}}/>
                                </div>
                                <div style={{fontSize:11,fontFamily:"monospace",color:"#aaa",minWidth:55,textAlign:"right"}}>{fmtLap(r.longRun)}</div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })()}

                  <div style={{display:"flex",gap:8,justifyContent:"flex-end",flexWrap:"wrap"}}>
                    <button onClick={()=>{
                      const ttl=activeDay?"Day "+testDay+" — "+activeDay.conditions.label:"Overall Standings";
                      const fn="f1sim-testing-"+(testSession.id||"test")+(activeDay?"-day"+testDay:"-overall")+".png";
                      const getLap=r=>r.bestLap??r.qualiSim;
                      const fastestLap=getLap(fastest);
                      const entries=displayResults.map((r,i)=>{const l=getLap(r);return{...r,gap:i===0||!l||!fastestLap?null:(l-fastestLap).toFixed(3)};});
                      downloadLeaderboardPNG(testSession.name+" — "+ttl,(testSession.dates||"Pre-Season Testing"),entries,"#4466FF",fn,{refQualSecs:fastestLap,showLaps:true});
                    }} style={{background:"#1E1E28",color:"#aaa",border:"1px solid #2A2A38",padding:"10px 16px",cursor:"pointer",fontFamily:"inherit",fontSize:13,fontWeight:700,letterSpacing:1,borderRadius:3}}>📷 PNG</button>
                    <button onClick={()=>exportTestingCSV(testResults,testSession)} style={{background:"#1E1E28",color:"#aaa",border:"1px solid #2A2A38",padding:"10px 16px",cursor:"pointer",fontFamily:"inherit",fontSize:13,fontWeight:700,letterSpacing:1,borderRadius:3}}>📊 Export CSV</button>
                    <button onClick={()=>doTest(testSession)} style={{background:"#2A2A30",color:"#ccc",border:"none",padding:"10px 18px",cursor:"pointer",fontFamily:"inherit",fontSize:13,fontWeight:700,letterSpacing:1.5,borderRadius:3}}>↺ RE-RUN TEST</button>
                    <button onClick={()=>setView("tracks")} style={{background:"#E8002D",color:"#fff",border:"none",padding:"10px 22px",cursor:"pointer",fontFamily:"inherit",fontSize:14,fontWeight:700,letterSpacing:2,borderRadius:3}}>SELECT RACE TRACK →</button>
                  </div>
                </>
              );
            })()}

            {!testResults&&(
              <div style={{background:"#111115",border:"1px solid #1E1E22",borderRadius:8,padding:50,textAlign:"center"}}>
                <div style={{fontSize:28,marginBottom:12}}>🔬</div>
                <div style={{fontSize:15,color:"#778",letterSpacing:1.5}}>Click a test session above to simulate it.</div>
              </div>
            )}
          </div>
        )}


        
        {view==="stats"&&(()=>{

          const totalRaces=championship.length;
          const simmed=simHistory.filter(h=>h.winnerCorrect!==undefined);
          const winAcc=simmed.length?simmed.filter(h=>h.winnerCorrect).length/simmed.length:null;
          const podAcc=simmed.length?(simmed.reduce((a,h)=>a+h.podiumHits/3,0)/simmed.length):null;

          // Confidence calibration: how often does predicted win% match reality
          // Group rounds by predicted win% bucket
          const buckets={};
          simmed.forEach(h=>{
            const b=Math.floor((h.predWinPct||0)*10)*10;
            if(!buckets[b]) buckets[b]={predicted:b/100,correct:0,total:0};
            buckets[b].total++;
            if(h.winnerCorrect) buckets[b].correct++;
          });
          const calPoints=Object.values(buckets).map(b=>({
            pct:b.predicted,actual:b.total>0?b.correct/b.total:null,n:b.total,
          })).filter(b=>b.actual!==null);

          // Per-driver prediction accuracy from championship rounds
          const driverPredAcc={};
          championship.forEach(r=>{
            if(!r.snapshot?.race) return;
            r.snapshot.race.positions.slice(0,3).forEach((e,i)=>{
              if(!driverPredAcc[e.driverName]) driverPredAcc[e.driverName]={actual:0,predicted:0,name:e.driverName};
              driverPredAcc[e.driverName].actual++;
            });
          });
          simHistory.forEach(h=>{
            if(!h.predictedWinner) return;
            if(!driverPredAcc[h.predictedWinner]) driverPredAcc[h.predictedWinner]={actual:0,predicted:0,name:h.predictedWinner};
            driverPredAcc[h.predictedWinner].predicted++;
          });

          // Model health score (0-100): accuracy * sim run depth * calibration
          const healthBase = simmed.length<3?null:Math.min(100,Math.round(
            ((winAcc||0.5)*40 + (podAcc||0.5)*30 + Math.min(1,simmed.length/20)*30)
          ));
          const avgRuns=simmed.length?Math.round(simmed.reduce((a,h)=>a+h.accuracy,0)/simmed.length):0;
          const dominantStyle=Object.entries(drivers.reduce((a,d)=>{a[d.style||"unknown"]=(a[d.style||"unknown"]||0)+1;return a},{})).sort((a,b)=>b[1]-a[1])[0]?.[0];

          return(
          <div style={{animation:"fadeIn 0.2s ease"}}>
            {/* Header */}
            <div style={{marginBottom:18}}>
              <div style={{fontSize:26,fontWeight:700,letterSpacing:3}}>📈 SIMULATION STATISTICS</div>
              <div style={{fontSize:14,color:"#778",marginTop:4,letterSpacing:1.5}}>
                Prediction accuracy, model confidence and data quality metrics
              </div>
            </div>

            {/* Model health banner */}
            {(()=>{
              const hasData=simmed.length>=3;
              const healthColor=!hasData?"#778":healthBase>=75?"#44CC88":healthBase>=50?"#FFC906":"#FF8844";
              return(
                <div style={{background:hasData?"#0D1A0D":"#111115",border:`1px solid ${healthColor}44`,borderLeft:`4px solid ${healthColor}`,borderRadius:"0 6px 6px 0",padding:"16px 20px",marginBottom:18}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:12}}>
                    <div>
                      <div style={{fontSize:12,color:healthColor,fontWeight:700,letterSpacing:2,marginBottom:6}}>
                        {hasData?"🧠 MODEL HEALTH SCORE":"🧠 MODEL BUILDING"}
                      </div>
                      <div style={{fontSize:13,color:"#aaa",lineHeight:1.7}}>
                        {!hasData
                          ?`Run Multi-Sim before saving races to build accuracy data. You need at least 3 saved rounds with sim predictions to calibrate the model. Current saved rounds: ${totalRaces}.`
                          :`Model trained on ${simmed.length} races · Average sim depth: ×${avgRuns} runs · Win prediction accuracy: ${(winAcc*100).toFixed(0)}% · Podium accuracy: ${(podAcc*100).toFixed(0)}%`}
                      </div>
                    </div>
                    {hasData&&(
                      <div style={{textAlign:"center"}}>
                        <div style={{fontSize:48,fontWeight:900,color:healthColor,lineHeight:1}}>{healthBase}</div>
                        <div style={{fontSize:11,color:"#778",letterSpacing:1.5}}>/100 MODEL SCORE</div>
                      </div>
                    )}
                  </div>
                </div>
              );
            })()}

            {/* Key metrics row */}
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(170px,1fr))",gap:10,marginBottom:18}}>
              {[
                ["Championship Rounds",totalRaces,"races saved","#E8002D"],
                ["Sim-Backed Rounds",simmed.length,"with predictions","#4488FF"],
                ["Win Prediction Accuracy",winAcc!=null?`${(winAcc*100).toFixed(0)}%`:"—","correct winner","#44CC88"],
                ["Podium Accuracy",podAcc!=null?`${(podAcc*100).toFixed(0)}%`:"—","avg 3 podium hits","#FFC906"],
                ["Avg Sim Depth",avgRuns>0?`×${avgRuns}`:"—","runs per race","#BB66FF"],
                ["Most Common Style",dominantStyle||"—","in your roster","#FF8844"],
              ].map(([l,v,sub,c])=>(
                <div key={l} style={{background:"#111115",border:`1px solid ${c}22`,borderTop:`2px solid ${c}`,borderRadius:"0 0 4px 4px",padding:"14px 16px"}}>
                  <div style={{fontSize:22,fontWeight:900,color:c,marginBottom:3}}>{v}</div>
                  <div style={{fontSize:11,color:"#aaa",marginBottom:3,fontWeight:700,letterSpacing:1}}>{l.toUpperCase()}</div>
                  <div style={{fontSize:11,color:"#556"}}>{sub}</div>
                </div>
              ))}
            </div>

            {/* ML explanation */}
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14,marginBottom:14}}>

              <div style={{background:"#111115",border:"1px solid #1E1E22",borderRadius:6,padding:"16px 18px"}}>
                <div style={{fontSize:12,color:"#4488FF",fontWeight:700,letterSpacing:2,marginBottom:12}}>🧬 HOW THE MODEL WORKS</div>
                <div style={{fontSize:13,color:"#aaa",lineHeight:1.8}}>
                  The simulator uses a <strong style={{color:"#F0F0F0"}}>weighted Monte Carlo engine</strong> — each race is run N times (your Accuracy setting) and the results aggregated to produce probabilities. The underlying model accounts for:
                </div>
                <div style={{marginTop:10,display:"grid",gap:5}}>
                  {[
                    ["Car Pace (55%)", "Team performance rating — the single biggest factor"],
                    ["Driver Stats (45%)", "Pace, Consistency, Wet, Overtaking, Defence, Experience"],
                    ["Track Variables", "Altitude, night, abrasion, DRS zones, street/technical type"],
                    ["Driving Style Mods", "8 archetypes apply permanent stat offsets"],
                    ["Session Form", "Random per-driver form factor per qualifying session"],
                    ["Team Strategy", "Pit stop philosophy affects race pace and DNF risk"],
                  ].map(([t,d])=>(
                    <div key={t} style={{display:"flex",gap:8,padding:"5px 8px",background:"#161618",borderRadius:3}}>
                      <span style={{fontSize:11,fontWeight:700,color:"#4488FF",minWidth:130,flexShrink:0}}>{t}</span>
                      <span style={{fontSize:11,color:"#778"}}>{d}</span>
                    </div>
                  ))}
                </div>
              </div>

            </div>

            {/* Prediction history */}
            {simmed.length>0&&(
              <div style={{marginBottom:14}}>
                <div style={{fontSize:12,color:"#778",fontWeight:700,letterSpacing:2,marginBottom:8}}>PREDICTION HISTORY ({simmed.length} ROUNDS)</div>
                <div style={{background:"#111115",border:"1px solid #1E1E22",borderRadius:6,overflow:"hidden"}}>
                  <div style={{display:"grid",gridTemplateColumns:"36px 1fr 1fr 1fr 80px 60px",gap:8,padding:"8px 14px",background:"#0D0D10",borderBottom:"1px solid #1E1E22"}}>
                    {["RND","TRACK","PREDICTED WIN","ACTUAL WIN","SIM RUNS","WIN ✓"].map(h=>(
                      <div key={h} style={{fontSize:11,color:"#778",fontWeight:700,letterSpacing:1.2}}>{h}</div>
                    ))}
                  </div>
                  {[...simmed].reverse().map((h,i)=>(
                    <div key={i} style={{display:"grid",gridTemplateColumns:"36px 1fr 1fr 1fr 80px 60px",gap:8,padding:"8px 14px",borderBottom:"1px solid #161618",background:i%2===0?"#111115":"#131316",alignItems:"center"}}>
                      <div style={{fontSize:13,color:"#778"}}>{h.round}</div>
                      <div style={{fontSize:13,fontWeight:700}}>{h.trackName||"—"}</div>
                      <div style={{fontSize:13,color:"#aaa"}}>{h.predictedWinner}
                        <span style={{fontSize:11,color:"#556",marginLeft:4}}>({(h.predWinPct*100).toFixed(0)}%)</span>
                      </div>
                      <div style={{fontSize:13,color:"#aaa"}}>{h.actualWinner}</div>
                      <div style={{fontSize:12,color:"#BB66FF"}}>×{h.accuracy}</div>
                      <div style={{fontSize:16}}>{h.winnerCorrect?"✅":"❌"}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Community model section */}
            <div style={{background:"#080F08",border:"1px solid #44CC8822",borderRadius:6,padding:"16px 18px",marginBottom:14}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
                <div style={{fontSize:12,color:"#44CC88",fontWeight:700,letterSpacing:2}}>🌍 COMMUNITY MODEL</div>
                <div style={{display:"flex",alignItems:"center",gap:8}}>
                  {communityLoading&&<span style={{fontSize:11,color:"#44CC88"}}>⟳ syncing…</span>}
                  <button
                    onClick={()=>{
                      if(!communityEnabled||SUPABASE_URL.includes('YOUR_PROJECT')) return;
                      setCommunityLoading(true);
                      sbSelect('community_model',`&circuit_id=eq.${track.id}`).then(rows=>{
                        setCommunityData(rows||null);
                        setCommunityLoading(false);
                      });
                    }}
                    disabled={!communityEnabled||SUPABASE_URL.includes('YOUR_PROJECT')}
                    title="Fetch latest ML model weights from server"
                    style={{background:"#0A1A0A",color:communityEnabled?"#44CC88":"#333",border:"1px solid #44CC8822",padding:"4px 10px",cursor:communityEnabled?"pointer":"default",fontFamily:"inherit",fontSize:11,fontWeight:700,borderRadius:3}}>
                    ⟳ FETCH MODEL
                  </button>
                  <button onClick={()=>setCommunityEnabled(p=>!p)}
                    style={{background:communityEnabled?"#44CC8822":"#1A1A1A",color:communityEnabled?"#44CC88":"#555",border:`1px solid ${communityEnabled?"#44CC8844":"#2A2A30"}`,padding:"4px 12px",cursor:"pointer",fontFamily:"inherit",fontSize:11,fontWeight:700,borderRadius:3}}>
                    {communityEnabled?"ON — Contributing":"OFF — Click to enable"}
                  </button>
                </div>
              </div>
              {!communityEnabled?(
                <div>
                  <div style={{fontSize:13,color:"#aaa",lineHeight:1.8,marginBottom:12}}>
                    When enabled, your anonymous simulation results are sent to a shared server. The aggregate data from all users improves predictions via Bayesian model blending — your local Monte Carlo is weighted with community-derived win rates for each circuit.
                  </div>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10}}>
                    {[
                      ["What IS shared","Circuit ID · Sim accuracy level · Predicted top-5 with win% · Your driver stat settings · Actual race result (if saved)"],
                      ["What is NOT shared","Your name · Your save file · Your championship · Any personally identifiable information"],
                      ["How it improves the model","After 30+ submissions per circuit, the community win rates are blended into your local predictions at up to 40% weight (Bayesian average)"],
                    ].map(([t,d])=>(
                      <div key={t} style={{background:"#111115",padding:"10px 12px",borderRadius:4,border:"1px solid #1E1E22"}}>
                        <div style={{fontSize:11,fontWeight:700,color:"#44CC88",marginBottom:4}}>{t}</div>
                        <div style={{fontSize:11,color:"#778",lineHeight:1.6}}>{d}</div>
                      </div>
                    ))}
                  </div>
                </div>
              ):(
                <div>
                  <div style={{fontSize:13,color:"#44CC88",marginBottom:10}}>
                    ✅ Community model active — anonymous data being shared. Multi-Sim results show 🌍 when blended with community data.
                    {SUPABASE_URL.includes("YOUR_PROJECT")&&<span style={{color:"#FFC906"}}> ⚠️ Supabase credentials not configured — data sharing inactive. See the setup guide.</span>}
                  </div>
                  {communityData&&communityData.length>0?(
                    <div>
                      <div style={{fontSize:11,color:"#778",marginBottom:8,letterSpacing:1.5}}>COMMUNITY DATA — {track.name.toUpperCase()}</div>
                      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(140px,1fr))",gap:6}}>
                        {communityData.slice(0,8).map((row,i)=>{
                          const drv=drivers.find(d=>d.id===row.driver_id);
                          return(
                            <div key={i} style={{background:"#111115",padding:"8px 10px",borderRadius:4,border:"1px solid #1E1E22"}}>
                              <div style={{fontSize:12,fontWeight:700,color:"#F0F0F0",marginBottom:2}}>{drv?`${drv.flag} ${drv.name.split(" ").pop()}`:(row.driver_id||"—")}</div>
                              <div style={{fontSize:11,color:"#44CC88"}}>Win: {((row.avg_win_pct||0)*100).toFixed(0)}%</div>
                              <div style={{fontSize:11,color:"#aaa"}}>Pod: {((row.avg_podium_pct||0)*100).toFixed(0)}%</div>
                              <div style={{fontSize:10,color:"#556",marginTop:2}}>n={row.sample_count||0}</div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ):(
                    <div style={{fontSize:13,color:"#778"}}>
                      No community data yet for {track.name}. Run Multi-Sim to contribute the first data points for this circuit.
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* ── LIVE DATA GRAPHS ─────────────────────────────── */}
            {/* ── MODEL PERFORMANCE DASHBOARD ───────────────────────── */}
            {(()=>{
              if(simmed.length < 2) return null;

              // SVG chart constants
              const CW=820,CH=180,P={t:32,r:24,b:36,l:52};
              const iW=CW-P.l-P.r, iH=CH-P.t-P.b;
              const sx=(i,n)=>P.l+(n<2?iW/2:(i/(n-1))*iW);
              const sy=(v,mn,mx)=>P.t+iH-((v-mn)/((mx-mn)||1))*iH;
              const polyPts=(vals,mn,mx)=>vals.map((v,i)=>`${sx(i,vals.length)},${sy(v,mn,mx)}`).join(" ");


              const roll5 = simmed.map((_,i)=>{
                const w=simmed.slice(Math.max(0,i-4),i+1);
                return w.filter(h=>h.winnerCorrect).length/w.length;
              });

              // Dataset 2: Predicted win% vs reality per round
              const predVsActual = simmed.map(h=>({
                pred: (h.predWinPct||0)*100,
                actual: h.winnerCorrect?100:0,
              }));


              const cumAcc = simmed.map((_,i)=>{
                const slice=simmed.slice(0,i+1);
                return slice.filter(h=>h.winnerCorrect).length/slice.length;
              });


              const depths = simmed.map(h=>h.accuracy||10);
              const dMax = Math.max(...depths, 20);


              // Combines accuracy + depth into a composite score
              const modelScore = simmed.map((_,i)=>{
                const accW=cumAcc[i];
                const depthW=Math.min(1,depths[i]/20);
                const dataW=Math.min(1,(i+1)/20);
                return Math.round((accW*50 + depthW*30 + dataW*20));
              });

              const overallAcc = simmed.filter(h=>h.winnerCorrect).length/simmed.length;
              const trend = roll5.length>=3 ? roll5[roll5.length-1]-roll5[roll5.length-3] : 0;
              const trendLabel = trend>0.05?"📈 Improving":trend<-0.05?"📉 Declining":"➡ Stable";
              const trendColor = trend>0.05?"#44CC88":trend<-0.05?"#E8002D":"#FFC906";

              return(<div style={{marginBottom:14}}>

                {/* Header row */}
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12,flexWrap:"wrap",gap:8}}>
                  <div style={{fontSize:12,color:"#BB66FF",fontWeight:700,letterSpacing:2}}>📊 MODEL PERFORMANCE TRACKER</div>
                  <div style={{display:"flex",gap:12,alignItems:"center"}}>
                    <span style={{fontSize:13,color:trendColor,fontWeight:700}}>{trendLabel}</span>
                    <span style={{fontSize:13,color:"#aaa"}}>{simmed.length} rounds tracked</span>
                    <span style={{fontSize:20,fontWeight:900,color:"#44CC88"}}>{(overallAcc*100).toFixed(0)}%</span>
                    <span style={{fontSize:11,color:"#556"}}>win accuracy</span>
                  </div>
                </div>

                {/* Chart 1: Model score + accuracy over time */}
                <div style={{background:"#111115",border:"1px solid #1E1E22",borderRadius:6,padding:"14px 16px",marginBottom:10}}>
                  <div style={{fontSize:11,color:"#778",fontWeight:700,letterSpacing:1.5,marginBottom:8}}>
                    MODEL SCORE & ACCURACY OVER TIME
                  </div>
                  <svg width="100%" viewBox={`0 0 ${CW} ${CH}`} style={{overflow:"visible"}}>
                    <defs>
                      <linearGradient id="gScore" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#BB66FF" stopOpacity="0.25"/>
                        <stop offset="100%" stopColor="#BB66FF" stopOpacity="0"/>
                      </linearGradient>
                      <linearGradient id="gAcc" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#44CC88" stopOpacity="0.15"/>
                        <stop offset="100%" stopColor="#44CC88" stopOpacity="0"/>
                      </linearGradient>
                    </defs>

                    {/* Grid lines */}
                    {[0,25,50,75,100].map(v=>(
                      <g key={v}>
                        <line x1={P.l} x2={CW-P.r} y1={sy(v,0,100)} y2={sy(v,0,100)} stroke="#1A1A22" strokeWidth="1"/>
                        <text x={P.l-6} y={sy(v,0,100)+4} textAnchor="end" fontSize="9" fill="#445">{v}</text>
                      </g>
                    ))}

                    {/* Model score area + line */}
                    {modelScore.length>=2&&(<>
                      <polygon
                        points={`${sx(0,modelScore.length)},${P.t+iH} ${polyPts(modelScore,0,100)} ${sx(modelScore.length-1,modelScore.length)},${P.t+iH}`}
                        fill="url(#gScore)"
                      />
                      <polyline points={polyPts(modelScore,0,100)} fill="none" stroke="#BB66FF" strokeWidth="2.5" strokeLinejoin="round"/>
                    </>)}

                    {/* Cumulative accuracy line */}
                    {cumAcc.length>=2&&(
                      <polyline points={polyPts(cumAcc.map(v=>v*100),0,100)} fill="none" stroke="#44CC88" strokeWidth="2" strokeLinejoin="round" strokeDasharray="5 3"/>
                    )}

                    {/* Rolling 5-round accuracy dots */}
                    {roll5.map((v,i)=>(
                      <circle key={i} cx={sx(i,roll5.length)} cy={sy(v*100,0,100)} r="3.5"
                        fill={v>=0.5?"#44CC88":"#E8002D"} stroke="#0C0C0F" strokeWidth="1.5"/>
                    ))}

                    {/* Round labels */}
                    {simmed.filter((_,i)=>i===0||i===simmed.length-1||(simmed.length>6&&i%Math.max(1,Math.floor(simmed.length/5))===0)).map((h,_,arr)=>{
                      const i=simmed.indexOf(h);
                      return <text key={i} x={sx(i,simmed.length)} y={CH-6} textAnchor="middle" fontSize="9" fill="#445">R{h.round}</text>;
                    })}

                    {/* Legend */}
                    <line x1={P.l+4} x2={P.l+20} y1={P.t-12} y2={P.t-12} stroke="#BB66FF" strokeWidth="2.5"/>
                    <text x={P.l+24} y={P.t-9} fontSize="9" fill="#778">Model score (0-100)</text>
                    <line x1={P.l+145} x2={P.l+161} y1={P.t-12} y2={P.t-12} stroke="#44CC88" strokeWidth="2" strokeDasharray="5 3"/>
                    <text x={P.l+165} y={P.t-9} fontSize="9" fill="#778">Cumulative accuracy %</text>
                    <circle cx={P.l+292} cy={P.t-12} r="3.5" fill="#44CC88"/>
                    <text x={P.l+299} y={P.t-9} fontSize="9" fill="#778">✅ correct</text>
                    <circle cx={P.l+348} cy={P.t-12} r="3.5" fill="#E8002D"/>
                    <text x={P.l+355} y={P.t-9} fontSize="9" fill="#778">❌ wrong</text>

                    {/* Current score callout */}
                    {modelScore.length>0&&(()=>{
                      const last=modelScore[modelScore.length-1];
                      const x=sx(modelScore.length-1,modelScore.length);
                      const y=sy(last,0,100);
                      return(<>
                        <circle cx={x} cy={y} r="6" fill="#BB66FF" stroke="#0C0C0F" strokeWidth="2"/>
                        <rect x={x+8} y={y-12} width={38} height={16} rx="3" fill="#1A0A2A"/>
                        <text x={x+27} y={y} textAnchor="middle" fontSize="10" fill="#BB66FF" fontWeight="700">{last}</text>
                      </>);
                    })()}
                  </svg>
                </div>

                {/* Bottom row: win/loss bars + sim depth */}
                <div style={{display:"grid",gridTemplateColumns:"2fr 1fr",gap:10,marginBottom:10}}>

                  {/* Win/loss per round bar chart */}
                  <div style={{background:"#111115",border:"1px solid #1E1E22",borderRadius:6,padding:"12px 14px"}}>
                    <div style={{fontSize:11,color:"#778",fontWeight:700,letterSpacing:1.5,marginBottom:8}}>
                      PREDICTION RESULT PER ROUND
                    </div>
                    <div style={{display:"flex",gap:3,alignItems:"flex-end",height:60}}>
                      {simmed.map((h,i)=>{
                        const barH = Math.max(8, (h.predWinPct||0.1)*200);
                        return(
                          <div key={i} style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:2,height:60,justifyContent:"flex-end"}}>
                            <div style={{
                              width:"100%",height:`${Math.min(52,barH)}px`,
                              background:h.winnerCorrect?"#44CC88":"#E8002D",
                              borderRadius:"2px 2px 0 0",opacity:0.8,
                              minHeight:8,
                            }}/>
                            <div style={{fontSize:8,color:"#445"}}>{h.round}</div>
                          </div>
                        );
                      })}
                    </div>
                    <div style={{display:"flex",gap:10,marginTop:6}}>
                      <div style={{display:"flex",alignItems:"center",gap:4}}>
                        <div style={{width:10,height:10,background:"#44CC88",borderRadius:2}}/>
                        <span style={{fontSize:10,color:"#778"}}>Correct {simmed.filter(h=>h.winnerCorrect).length}</span>
                      </div>
                      <div style={{display:"flex",alignItems:"center",gap:4}}>
                        <div style={{width:10,height:10,background:"#E8002D",borderRadius:2}}/>
                        <span style={{fontSize:10,color:"#778"}}>Wrong {simmed.filter(h=>!h.winnerCorrect).length}</span>
                      </div>
                    </div>
                  </div>

                  {/* Sim depth radial/gauge */}
                  <div style={{background:"#111115",border:"1px solid #1E1E22",borderRadius:6,padding:"12px 14px",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center"}}>
                    <div style={{fontSize:11,color:"#778",fontWeight:700,letterSpacing:1.5,marginBottom:8,alignSelf:"flex-start"}}>AVG SIM DEPTH</div>
                    {(()=>{
                      const avg=depths.reduce((a,b)=>a+b,0)/depths.length;
                      const pct=avg/20;
                      const r=38, cx=60, cy=50;
                      const startAngle=-Math.PI*0.75, endAngle=Math.PI*0.75;
                      const angle=startAngle+(endAngle-startAngle)*pct;
                      const x1=cx+r*Math.cos(startAngle), y1=cy+r*Math.sin(startAngle);
                      const x2=cx+r*Math.cos(endAngle),   y2=cy+r*Math.sin(endAngle);
                      const xN=cx+r*Math.cos(angle),      yN=cy+r*Math.sin(angle);
                      const large=pct>0.5?1:0;
                      const col=avg>=15?"#44CC88":avg>=10?"#FFC906":"#E8002D";
                      return(
                        <svg width="120" height="80" viewBox="0 0 120 80">
                          <path d={`M${x1},${y1} A${r},${r} 0 1 1 ${x2},${y2}`} fill="none" stroke="#1E1E22" strokeWidth="8" strokeLinecap="round"/>
                          <path d={`M${x1},${y1} A${r},${r} 0 ${large} 1 ${xN},${yN}`} fill="none" stroke={col} strokeWidth="8" strokeLinecap="round"/>
                          <text x={cx} y={cy+6} textAnchor="middle" fontSize="18" fontWeight="900" fill={col}>×{avg.toFixed(0)}</text>
                          <text x={cx} y={cy+20} textAnchor="middle" fontSize="9" fill="#445">avg runs</text>
                        </svg>
                      );
                    })()}
                  </div>
                </div>

                {/* Community data bar chart if available */}
                {(communityData||[]).length>0&&(()=>{
                  const rows=(communityData||[]).slice(0,10).map(r=>({
                    id:(drivers.find(d=>d.id===r.driver_id)?.name||r.driver_id||"").split(" ").pop(),
                    winPct:(r.avg_win_pct||0)*100,
                    n:r.sample_count||0,
                    col:drivers.find(d=>d.id===r.driver_id)?.color||"4488FF",
                  })).sort((a,b)=>b.winPct-a.winPct);
                  const maxW=Math.max(...rows.map(r=>r.winPct),5);
                  const BW=820,BH=100,BP={t:18,r:16,b:28,l:50};
                  return(
                    <div style={{background:"#080F08",border:"1px solid #44CC8822",borderRadius:6,padding:"12px 14px",marginBottom:10}}>
                      <div style={{fontSize:11,color:"#44CC88",fontWeight:700,letterSpacing:1.5,marginBottom:8}}>
                        🌍 COMMUNITY WIN RATES — {track.name.toUpperCase()} (n={rows.reduce((a,r)=>a+r.n,0)} submissions)
                      </div>
                      <svg width="100%" viewBox={`0 0 ${BW} ${BH}`} style={{overflow:"visible"}}>
                        {[0,10,20,30].filter(v=>v<=maxW+5).map(v=>{
                          const y=BP.t+(BH-BP.t-BP.b)*(1-v/maxW);
                          return(<g key={v}><line x1={BP.l} x2={BW-BP.r} y1={y} y2={y} stroke="#1A2A1A" strokeWidth="1"/>
                            <text x={BP.l-4} y={y+4} textAnchor="end" fontSize="9" fill="#445">{v}%</text></g>);
                        })}
                        {rows.map((d,i)=>{
                          const bW=Math.min(55,(BW-BP.l-BP.r)/rows.length-6);
                          const x=BP.l+i*(bW+6)+3;
                          const bH=(BH-BP.t-BP.b)*(d.winPct/maxW);
                          const y=BP.t+(BH-BP.t-BP.b)-bH;
                          return(<g key={i}>
                            <rect x={x} y={y} width={bW} height={bH} fill={`#${d.col}`} opacity="0.75" rx="2"/>
                            <text x={x+bW/2} y={y-4} textAnchor="middle" fontSize="9" fill={`#${d.col}`} fontWeight="700">{d.winPct.toFixed(0)}%</text>
                            <text x={x+bW/2} y={BH-6} textAnchor="middle" fontSize="8" fill="#556">{d.id.slice(0,7)}</text>
                          </g>);
                        })}
                      </svg>
                    </div>
                  );
                })()}

              </div>);
            })()}


            {/* ── LIGHTGBM MODEL DASHBOARD ─────────────────────────────── */}
            {(()=>{
              const global = communityStats;
              const allData = allCircuitData||[];

              // Aggregate: total samples and drivers per circuit
              const circuitMap = {};
              allData.forEach(r=>{
                if(!circuitMap[r.circuit_id]) circuitMap[r.circuit_id]={
                  circuit_id:r.circuit_id, total_samples:0, drivers:0, top_win_pct:0,
                };
                circuitMap[r.circuit_id].total_samples += r.sample_count||0;
                circuitMap[r.circuit_id].drivers++;
                if((r.avg_win_pct||0)>circuitMap[r.circuit_id].top_win_pct)
                  circuitMap[r.circuit_id].top_win_pct=r.avg_win_pct||0;
              });
              const circuits = Object.values(circuitMap).sort((a,b)=>b.total_samples-a.total_samples);
              const totalSims   = global?.total_sims||0;
              const withResult  = global?.total_with_result||0;
              const winAcc      = global?.win_accuracy||0;
              const podAcc      = global?.podium_accuracy||0;
              const topCircuit  = global?.most_active_circuit||"—";
              const modelReady  = totalSims>=50;
              const hasData     = allData.length>0||totalSims>0;

              // SVG helpers
              const bCol=n=>n>=100?"#44CC88":n>=30?"#FFC906":"#E8002D";
              const scoreColor=s=>s>=70?"#44CC88":s>=45?"#FFC906":"#E8002D";
              const modelScore=modelReady?Math.min(100,Math.round(
                winAcc*40 + podAcc*20 + Math.min(1,totalSims/500)*20 + Math.min(1,withResult/100)*20
              )):null;

              return(
              <div style={{background:"#080810",border:"1px solid #4488FF22",borderRadius:8,padding:"18px 20px",marginBottom:14}}>

                {/* Header */}
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16,flexWrap:"wrap",gap:10}}>
                  <div>
                    <div style={{fontSize:13,color:"#4488FF",fontWeight:700,letterSpacing:2,marginBottom:4}}>
                      🧠 LIGHTGBM COMMUNITY MODEL
                    </div>
                    <div style={{fontSize:12,color:"#556"}}>
                      {communityEnabled?"Fetching live model data from Supabase":"Enable 🟢 LIVE to see community model data"}
                    </div>
                  </div>
                  {modelScore!==null&&(
                    <div style={{textAlign:"center",background:"#0A0A14",border:`2px solid ${scoreColor(modelScore)}44`,borderRadius:8,padding:"10px 18px"}}>
                      <div style={{fontSize:36,fontWeight:900,color:scoreColor(modelScore),lineHeight:1}}>{modelScore}</div>
                      <div style={{fontSize:10,color:"#556",letterSpacing:1.5,marginTop:2}}>MODEL SCORE /100</div>
                    </div>
                  )}
                </div>

                {!communityEnabled?(
                  <div style={{textAlign:"center",padding:"30px 0",color:"#445",fontSize:13}}>
                    Enable community mode (🟢 LIVE in the nav bar) to connect to the LightGBM model
                  </div>
                ):!hasData?(
                  <div style={{textAlign:"center",padding:"30px 0"}}>
                    <div style={{fontSize:13,color:"#556",marginBottom:8}}>No model data yet</div>
                    <div style={{fontSize:12,color:"#444"}}>Run Multi-Sim and save races with 🟢 LIVE enabled to start training the model</div>
                  </div>
                ):(
                  <>
                  {/* Key metrics */}
                  <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:8,marginBottom:16}}>
                    {[
                      ["Total Submissions",totalSims,"race simulations","#4488FF"],
                      ["With Real Results",withResult,"actual winners logged","#FFC906"],
                      ["Win Prediction",winAcc>0?`${(winAcc*100).toFixed(0)}%`:"—","accuracy vs actual","#44CC88"],
                      ["Most Active",topCircuit,"circuit by volume","#BB66FF"],
                    ].map(([l,v,s,c])=>(
                      <div key={l} style={{background:"#0C0C16",border:`1px solid ${c}22`,borderTop:`2px solid ${c}`,borderRadius:"0 0 4px 4px",padding:"12px 14px"}}>
                        <div style={{fontSize:20,fontWeight:900,color:c,marginBottom:2}}>{v}</div>
                        <div style={{fontSize:10,color:"#778",fontWeight:700,letterSpacing:1,marginBottom:2}}>{l.toUpperCase()}</div>
                        <div style={{fontSize:10,color:"#445"}}>{s}</div>
                      </div>
                    ))}
                  </div>

                  {/* Training data volume by circuit */}
                  {circuits.length>0&&(()=>{
                    const MAX_SHOW=20;
                    const shown=circuits.slice(0,MAX_SHOW);
                    const maxN=Math.max(...shown.map(c=>c.total_samples),1);
                    const THRESHOLD=30; // min samples before model trusts the circuit
                    const BW=820,BH=140,BP={t:20,r:16,b:36,l:16};
                    const barW=Math.max(18,Math.floor((BW-BP.l-BP.r-shown.length*4)/shown.length));
                    return(
                      <div style={{marginBottom:14}}>
                        <div style={{fontSize:11,color:"#778",fontWeight:700,letterSpacing:1.5,marginBottom:8}}>
                          TRAINING DATA VOLUME PER CIRCUIT
                          <span style={{fontWeight:400,color:"#445",marginLeft:8}}>— dashed line = 30 sample threshold (minimum for model blending)</span>
                        </div>
                        <div style={{background:"#0C0C16",border:"1px solid #1A1A28",borderRadius:6,padding:"10px 12px"}}>
                          <svg width="100%" viewBox={`0 0 ${BW} ${BH}`} style={{overflow:"visible"}}>
                            {/* Threshold line at 30 samples */}
                            {(()=>{
                              const ty=BP.t+(BH-BP.t-BP.b)*(1-THRESHOLD/maxN);
                              return(<>
                                <line x1={BP.l} x2={BW-BP.r} y1={ty} y2={ty}
                                  stroke="#FFC906" strokeWidth="1.5" strokeDasharray="6 4" opacity="0.7"/>
                                <text x={BW-BP.r+4} y={ty+4} fontSize="9" fill="#FFC906">min 30</text>
                              </>);
                            })()}
                            {/* Y axis labels */}
                            {[0,maxN/2,maxN].map((v,i)=>{
                              const y=BP.t+(BH-BP.t-BP.b)*(1-v/maxN);
                              return <text key={i} x={BW-BP.r+4} y={y+4} fontSize="8" fill="#333">{Math.round(v)}</text>;
                            })}
                            {/* Bars */}
                            {shown.map((c,i)=>{
                              const x=BP.l+i*(barW+4);
                              const bH=Math.max(2,(BH-BP.t-BP.b)*(c.total_samples/maxN));
                              const y=BP.t+(BH-BP.t-BP.b)-bH;
                              const col=bCol(c.total_samples);
                              return(<g key={c.circuit_id}>
                                <rect x={x} y={y} width={barW} height={bH} fill={col} opacity="0.8" rx="2"/>
                                <text x={x+barW/2} y={y-4} textAnchor="middle" fontSize="8" fill={col} fontWeight="700">
                                  {c.total_samples}
                                </text>
                                <text x={x+barW/2} y={BH-BP.b+14} textAnchor="middle" fontSize="7" fill="#445"
                                  transform={`rotate(-35,${x+barW/2},${BH-BP.b+14})`}>
                                  {c.circuit_id.slice(0,5)}
                                </text>
                              </g>);
                            })}
                          </svg>
                          <div style={{display:"flex",gap:14,marginTop:4,justifyContent:"center"}}>
                            {[["🟢 ≥100 (high confidence)","#44CC88"],["🟡 30-99 (blending active)","#FFC906"],["🔴 <30 (below threshold)","#E8002D"]].map(([l,c])=>(
                              <div key={l} style={{fontSize:10,color:c}}>{l}</div>
                            ))}
                          </div>
                        </div>
                      </div>
                    );
                  })()}

                  {/* Model accuracy vs local Monte Carlo */}
                  {winAcc>0&&withResult>0&&(
                    <div style={{marginBottom:14}}>
                      <div style={{fontSize:11,color:"#778",fontWeight:700,letterSpacing:1.5,marginBottom:8}}>
                        LIGHTGBM vs LOCAL MODEL — WIN PREDICTION ACCURACY
                      </div>
                      <div style={{background:"#0C0C16",border:"1px solid #1A1A28",borderRadius:6,padding:"14px 16px"}}>
                        {(()=>{
                          const localAcc = simHistory.filter(h=>h.winnerCorrect!==undefined).length>0
                            ? simHistory.filter(h=>h.winnerCorrect).length/simHistory.filter(h=>h.winnerCorrect!==undefined).length
                            : null;
                          const W=820,H=80,P={t:10,r:120,b:10,l:16};
                          const iW=W-P.l-P.r;
                          const bar=(pct,col,y,label,n)=>{
                            const w=Math.max(4,iW*pct);
                            return(<g>
                              <rect x={P.l} y={y} width={w} height={22} fill={col} opacity="0.8" rx="3"/>
                              <rect x={P.l} y={y} width={iW} height={22} fill="none" stroke={col} strokeWidth="1" rx="3" opacity="0.2"/>
                              <text x={P.l+w+6} y={y+15} fontSize="13" fontWeight="900" fill={col}>{(pct*100).toFixed(0)}%</text>
                              <text x={W-P.r+10} y={y+9}  fontSize="9" fill="#778" fontWeight="700">{label}</text>
                              <text x={W-P.r+10} y={y+21} fontSize="9" fill="#445">{n}</text>
                            </g>);
                          };
                          return(
                            <svg width="100%" viewBox={`0 0 ${W} ${H}`}>
                              {bar(winAcc,"#4488FF",P.t,"LightGBM (community)",`n=${withResult} labelled`)}
                              {localAcc!==null&&bar(localAcc,"#44CC88",P.t+36,"Local Monte Carlo",`n=${simHistory.filter(h=>h.winnerCorrect!==undefined).length} rounds`)}
                              {localAcc===null&&(
                                <text x={P.l} y={P.t+52} fontSize="11" fill="#445">Local accuracy: run Multi-Sim before saving races to track</text>
                              )}
                            </svg>
                          );
                        })()}
                        <div style={{fontSize:11,color:"#556",marginTop:8,lineHeight:1.7}}>
                          LightGBM is trained on all {totalSims} community submissions. It improves as more users play with 🟢 LIVE enabled and save races — each saved result provides a labelled training example (predicted winner vs actual winner).
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Circuit coverage heatmap */}
                  {circuits.length>0&&(()=>{
                    const allCircuits=["australia","china","japan","bahrain","saudi","miami","spain","monaco","canada","madrid","austria","britain","hungary","belgium","netherlands","italy","azerbaijan","singapore","usa","mexico","brazil","lasvegas","qatar","abudhabi"];
                    return(
                      <div>
                        <div style={{fontSize:11,color:"#778",fontWeight:700,letterSpacing:1.5,marginBottom:8}}>
                          CIRCUIT COVERAGE — {circuits.filter(c=>c.total_samples>=30).length}/{allCircuits.length} CIRCUITS ABOVE THRESHOLD
                        </div>
                        <div style={{display:"grid",gridTemplateColumns:"repeat(12,1fr)",gap:4}}>
                          {allCircuits.map(cid=>{
                            const c=circuitMap[cid];
                            const n=c?c.total_samples:0;
                            const col=n>=100?"#44CC88":n>=30?"#FFC906":n>0?"#883322":"#1A1A22";
                            const trk=TRACKS?TRACKS.find(t=>t.id===cid):null;
                            return(
                              <div key={cid} title={`${cid}: ${n} samples`}
                                style={{background:col,borderRadius:3,height:28,display:"flex",alignItems:"center",
                                  justifyContent:"center",flexDirection:"column",cursor:"default",opacity:0.85}}>
                                <div style={{fontSize:8,color:"#000",fontWeight:700,opacity:0.8}}>{cid.slice(0,3).toUpperCase()}</div>
                                <div style={{fontSize:7,color:"#000",opacity:0.7}}>{n||""}</div>
                              </div>
                            );
                          })}
                        </div>
                        <div style={{display:"flex",gap:12,marginTop:8,justifyContent:"flex-end"}}>
                          {[["≥100","#44CC88"],["30-99","#FFC906"],["1-29","#883322"],["0","#1A1A22"]].map(([l,c])=>(
                            <div key={l} style={{display:"flex",alignItems:"center",gap:4}}>
                              <div style={{width:10,height:10,background:c,borderRadius:2}}/>
                              <span style={{fontSize:10,color:"#556"}}>{l}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })()}
                  </>
                )}
              </div>
              );
            })()}

            {/* Improvement tips */}
            <div style={{background:"#0D0D10",border:"1px solid #1E1E22",borderRadius:6,padding:"16px 18px"}}>
              <div style={{fontSize:12,color:"#44CC88",fontWeight:700,letterSpacing:2,marginBottom:12}}>💡 HOW TO IMPROVE PREDICTION ACCURACY</div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10}}>
                {[
                  ["Use ×20 Accuracy","Run Multi-Sim at ×20 before every race. More samples = lower variance = better predictions."],
                  ["Update Stats After Real Races","After a real F1 race, bump the winner's Pace by 1-2, drop consistent retirees' Mental by 1."],
                  ["Tune Good/Bad Tracks","Set specific Good/Bad tracks from real lap-time data. A driver 0.5s quicker at one track = mark it Good."],
                  ["Run Multi-Sim First","Always open Multi-Sim, run it, then open the single race. The model remembers your last sim for comparison."],
                  ["Track Strategy Accuracy","After real pitstop data, switch teams to their actual strategy archetype for better race predictions."],
                  ["Build More Data","Model accuracy improves with rounds. Aim for 10+ saved championship rounds for reliable calibration."],
                ].map(([t,d])=>(
                  <div key={t} style={{background:"#161618",padding:"10px 12px",borderRadius:4,borderLeft:"3px solid #44CC88"}}>
                    <div style={{fontSize:12,fontWeight:700,color:"#F0F0F0",marginBottom:4}}>{t}</div>
                    <div style={{fontSize:11,color:"#778",lineHeight:1.6}}>{d}</div>
                  </div>
                ))}
              </div>
            </div>

          </div>
          );
        })()}

        
        {view==="multisim"&&(
          <div style={{animation:"fadeIn 0.2s ease"}}>
            {/* Header + controls */}
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:18,flexWrap:"wrap",gap:12}}>
              <div>
                <div style={{fontSize:26,fontWeight:700,letterSpacing:3}}>📊 MONTE CARLO SIMULATION</div>
                <div style={{fontSize:14,color:"#778",letterSpacing:1.5,marginTop:3}}>
                  {track.flag} {track.name} · Run the race N times to find the most probable outcome
                </div>
              </div>
              <div style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
                <div style={{display:"flex",gap:6}}>
                  {[5,10,15,20].map(n=>(
                    <button key={n} onClick={()=>setSimCount(n)} style={{background:simCount===n?"#E8002D":"#1E1E22",color:simCount===n?"#fff":"#aaa",border:`1px solid ${simCount===n?"#E8002D":"#2A2A30"}`,padding:"7px 14px",cursor:"pointer",fontFamily:"inherit",fontSize:14,fontWeight:700,letterSpacing:1.5,borderRadius:3}}>×{n}</button>
                  ))}
                </div>
                <button onClick={doMultiSim} disabled={simRunning} style={{background:simRunning?"#1A1A1A":"#E8002D",color:"#fff",border:"none",padding:"9px 22px",cursor:simRunning?"default":"pointer",fontFamily:"inherit",fontSize:14,fontWeight:700,letterSpacing:2,borderRadius:3,opacity:simRunning?0.6:1}}>
                  {simRunning?`RUNNING ${simCount} RACES…`:`▶ RUN ${simCount} SIMULATIONS`}
                </button>
              </div>
            </div>

            {/* Legend */}
            <div style={{display:"flex",gap:16,marginBottom:16,flexWrap:"wrap"}}>
              {[["AVG","Average finishing position"],["POLE%","Pole position probability"],["WIN%","Race win probability"],["POD%","Podium (top 3) probability"],["PTS","Total points across all runs"],["DNF%","Retirement probability"]].map(([l,d])=>(
                <div key={l} style={{fontSize:12,color:"#778"}}><span style={{color:"#aaa",fontWeight:700}}>{l}</span> {d}</div>
              ))}
            </div>

            {!simResults&&!simRunning&&(
              <div style={{background:"#111115",border:"1px solid #1E1E22",borderRadius:8,padding:60,textAlign:"center"}}>
                <div style={{fontSize:32,marginBottom:12}}>📊</div>
                <div style={{fontSize:16,color:"#778",letterSpacing:1.5,marginBottom:8}}>Select how many runs and hit RUN SIMULATIONS</div>
                <div style={{fontSize:13,color:"#555",maxWidth:500,margin:"0 auto",lineHeight:1.7}}>
                  Each run generates a full qualifying session, optional sprint, and race. Results are aggregated to show probabilities and averages — much more reliable than a single race.
                </div>
              </div>
            )}

            {simRunning&&(
              <div style={{background:"#111115",border:"1px solid #1E1E22",borderRadius:8,padding:60,textAlign:"center"}}>
                <div style={{fontSize:16,fontWeight:700,color:"#E8002D",letterSpacing:2,animation:"pulse 1s ease-in-out infinite"}}>
                  SIMULATING {simCount} RACES AT {track.circuit.toUpperCase()}…
                </div>
                <div style={{fontSize:13,color:"#778",marginTop:10}}>Running qualifying, {track.hasSprint?"sprint, ":""}and race {simCount} times</div>
              </div>
            )}

            {simResults&&!simRunning&&(()=>{
              const maxPts=simResults[0]?.totalPts||1;
              const maxAvgPts=simResults[0]?.avgRacePts||1;
              return(
                <>
                  {/* Summary podium */}
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10,marginBottom:18}}>
                    {simResults.slice(0,3).map((r,i)=>{
                      const medals=["🥇","🥈","🥉"];
                      const bgs=["#181408","#141414","#141008"];
                      const borders=["#FFC906","#aaa","#CD7F32"];
                      return(
                        <div key={r.driver.id} style={{background:bgs[i],border:`1px solid ${borders[i]}44`,borderTop:`3px solid ${borders[i]}`,borderRadius:4,padding:"16px 18px",textAlign:"center"}}>
                          <div style={{fontSize:28}}>{medals[i]}</div>
                          <div style={{fontSize:18,fontWeight:700,marginTop:6,color:borders[i]}}>{r.driver.name}</div>
                          <div style={{fontSize:13,color:r.team?.color||"#aaa",letterSpacing:1.5,marginTop:2}}>{r.team?.name}</div>
                          <div style={{display:"flex",justifyContent:"center",gap:14,marginTop:10,flexWrap:"wrap"}}>
                            <div style={{textAlign:"center"}}>
                              <div style={{fontSize:22,fontWeight:900,color:borders[i]}}>{(r.winPct*100).toFixed(0)}%</div>
                              <div style={{fontSize:11,color:"#778",letterSpacing:1}}>WIN RATE</div>
                            </div>
                            <div style={{textAlign:"center"}}>
                              <div style={{fontSize:22,fontWeight:900,color:"#F0F0F0"}}>{r.avgPos.toFixed(1)}</div>
                              <div style={{fontSize:11,color:"#778",letterSpacing:1}}>AVG POS</div>
                            </div>
                            <div style={{textAlign:"center"}}>
                              <div style={{fontSize:22,fontWeight:900,color:"#44CC88"}}>{r.totalPts}</div>
                              <div style={{fontSize:11,color:"#778",letterSpacing:1}}>TOTAL PTS</div>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {/* Full results table */}
                  <div style={{background:"#111115",border:"1px solid #1E1E22",borderRadius:6,overflow:"hidden"}}>
                    {/* Table header */}
                    <div style={{display:"grid",gridTemplateColumns:"36px 1fr 70px 70px 70px 70px 80px 60px",gap:0,background:"#0D0D10",padding:"10px 14px",borderBottom:"1px solid #1E1E22"}}>
                      {["#","DRIVER","AVG","POLE%","WIN%","POD%","PTS","DNF%"].map(h=>(
                        <div key={h} style={{fontSize:11,color:"#778",fontWeight:700,letterSpacing:1.5,textAlign:h==="DRIVER"?"left":"right"}}>{h}</div>
                      ))}
                    </div>
                    {simResults.map((r,i)=>{
                      const winColor=r.winPct>0.3?"#FFC906":r.winPct>0.1?"#44CC88":"#aaa";
                      const dnfColor=r.dnfPct>0.25?"#FF4444":r.dnfPct>0.12?"#FF8844":"#778";
                      return(
                        <div key={r.driver.id} style={{display:"grid",gridTemplateColumns:"36px 1fr 70px 70px 70px 70px 80px 60px",gap:0,padding:"9px 14px",borderBottom:"1px solid #1A1A1E",background:i<3?"#16160E":"#111115",alignItems:"center"}}>
                          {/* Pos */}
                          <div style={{fontSize:13,fontWeight:700,color:i===0?"#FFC906":i===1?"#aaa":i===2?"#CD7F32":"#778"}}>{i+1}</div>
                          {/* Driver */}
                          <div>
                            <div style={{display:"flex",alignItems:"center",gap:8}}>
                              <div style={{width:3,height:28,background:r.team?.color||"#555",borderRadius:2,flexShrink:0}}/>
                              <div>
                                <div style={{fontSize:14,fontWeight:700}}>{r.driver.flag} {r.driver.name}</div>
                                <div style={{fontSize:12,color:r.team?.color||"#aaa"}}>{r.team?.name}</div>
                              </div>
                            </div>
                          </div>
                          {/* Avg pos with mini bar */}
                          <div style={{textAlign:"right"}}>
                            <div style={{fontSize:14,fontWeight:700,fontFamily:"monospace",color:i<3?"#FFC906":"#F0F0F0"}}>{r.avgPos.toFixed(1)}</div>
                            <div style={{fontSize:11,color:"#778"}}>Q:{r.avgQualPos.toFixed(1)}</div>
                          </div>
                          {/* Pole% */}
                          <div style={{textAlign:"right"}}>
                            <div style={{fontSize:14,fontWeight:700,color:r.polePct>0?"#FFC906":"#778"}}>{r.polePct>0?`${(r.polePct*100).toFixed(0)}%`:"—"}</div>
                            <div style={{fontSize:11,color:"#778"}}>{r.poles}/{simCount}</div>
                          </div>
                          {/* Win% */}
                          <div style={{textAlign:"right"}}>
                            <div style={{fontSize:14,fontWeight:700,color:winColor}}>{r.wins>0?`${(r.winPct*100).toFixed(0)}%`:"—"}</div>
                            <div style={{fontSize:11,color:"#778"}}>{r.wins}/{simCount}</div>
                          </div>
                          {/* Pod% */}
                          <div style={{textAlign:"right"}}>
                            <div style={{fontSize:14,fontWeight:700,color:r.podiumPct>0?"#44CC88":"#778"}}>{r.podiums>0?`${(r.podiumPct*100).toFixed(0)}%`:"—"}</div>
                            <div style={{fontSize:11,color:"#778"}}>{r.podiums}/{simCount}</div>
                          </div>
                          {/* Pts with bar */}
                          <div style={{textAlign:"right"}}>
                            <div style={{fontSize:14,fontWeight:700,color:"#F0F0F0"}}>{r.totalPts}</div>
                            <div style={{height:4,background:"#1A1A1A",borderRadius:2,marginTop:3}}>
                              <div style={{height:4,width:`${(r.totalPts/maxPts)*100}%`,background:r.team?.color||"#E8002D",borderRadius:2}}/>
                            </div>
                          </div>
                          {/* DNF% */}
                          <div style={{textAlign:"right"}}>
                            <div style={{fontSize:14,fontWeight:700,color:dnfColor}}>{r.dnfPct>0?`${(r.dnfPct*100).toFixed(0)}%`:"—"}</div>
                            <div style={{fontSize:11,color:"#778"}}>{r.dnfs}/{simCount}</div>
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {/* Sprint summary if applicable */}
                  {track.hasSprint&&simResults.some(r=>r.avgSprintPts>0)&&(
                    <div style={{marginTop:16}}>
                      <div style={{fontSize:13,color:"#FFC906",letterSpacing:2.5,marginBottom:8,fontWeight:700}}>⚡ SPRINT SUMMARY</div>
                      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(200px,1fr))",gap:6}}>
                        {simResults.filter(r=>r.avgSprintPts>0).slice(0,8).map(r=>(
                          <div key={r.driver.id} style={{display:"flex",alignItems:"center",gap:10,padding:"9px 12px",background:"#161618",border:"1px solid #FFC90622",borderLeft:`3px solid ${r.team?.color||"#555"}`,borderRadius:3}}>
                            <div style={{flex:1}}>
                              <div style={{fontSize:14,fontWeight:700}}>{r.driver.name.split(" ").pop()}</div>
                              <div style={{fontSize:12,color:"#778"}}>
                                {r.sprintWins>0&&<span style={{color:"#FFC906",marginRight:6}}>⚡{r.sprintWins}W</span>}
                                avg {r.avgSprintPts.toFixed(1)}pts
                              </div>
                            </div>
                            <div style={{fontSize:18,fontWeight:900,color:"#FFC906",fontFamily:"monospace"}}>{(r.avgSprintPts*simCount).toFixed(0)}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  <div style={{display:"flex",gap:8,justifyContent:"flex-end",marginTop:14,flexWrap:"wrap"}}>
                    <button onClick={doMultiSim} style={{background:"#2A2A30",color:"#ccc",border:"none",padding:"10px 18px",cursor:"pointer",fontFamily:"inherit",fontSize:14,fontWeight:700,letterSpacing:1.5,borderRadius:3}}>↺ RUN AGAIN</button>
                    <button onClick={()=>setView("tracks")} style={{background:"#E8002D",color:"#fff",border:"none",padding:"10px 22px",cursor:"pointer",fontFamily:"inherit",fontSize:14,fontWeight:700,letterSpacing:2,borderRadius:3}}>NEW TRACK →</button>
                  </div>
                </>
              );
            })()}
          </div>
        )}

        
        {view==="championship"&&(
          <div style={{animation:"fadeIn 0.2s ease"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:16,flexWrap:"wrap",gap:10}}>
              <div>
                <div style={{fontSize:26,fontWeight:700,letterSpacing:3}}>🏆 CHAMPIONSHIP</div>
                <div style={{fontSize:14,color:"#778",letterSpacing:1.5,marginTop:2}}>{championship.length} ROUNDS COMPLETED · 2027 SEASON</div>
              </div>
              <div style={{display:"flex",gap:8}}>
                <button onClick={()=>{if(championship.length>0)setChampionship(prev=>prev.slice(0,-1));}} disabled={championship.length===0}
                  style={{background:championship.length===0?"#1A1A1A":"#2A2A30",color:championship.length===0?"#bbb":"#FFC906",border:`1px solid ${championship.length===0?"#1A1A1A":"#FFC90644"}`,padding:"8px 16px",cursor:championship.length===0?"default":"pointer",fontFamily:"inherit",fontSize:14,fontWeight:700,letterSpacing:1.5,borderRadius:3}}>
                  ↩ UNDO LAST
                </button>
                <button onClick={()=>{if(window.confirm("Reset the entire championship? This cannot be undone.")){{setChampionship([]);setSelectedRound(null);setTeamBudgets(initBudgets());}}}} disabled={championship.length===0}
                  style={{background:championship.length===0?"#1A1A1A":"#2A1010",color:championship.length===0?"#bbb":"#FF4444",border:`1px solid ${championship.length===0?"#1A1A1A":"#FF444444"}`,padding:"8px 16px",cursor:championship.length===0?"default":"pointer",fontFamily:"inherit",fontSize:14,fontWeight:700,letterSpacing:1.5,borderRadius:3}}>
                  ✕ RESET
                </button>
              </div>
            </div>

            {championship.length===0?(
              <div style={{background:"#111115",border:"1px solid #1E1E22",borderRadius:8,padding:50,textAlign:"center"}}>
                <div style={{fontSize:32,marginBottom:12}}>🏆</div>
                <div style={{fontSize:16,color:"#778",letterSpacing:1.5}}>No races saved yet. Complete a race and click "Save to Championship".</div>
              </div>
            ):(
              <>
                <div style={{display:"flex",gap:3,marginBottom:16,background:"#111115",border:"1px solid #1E1E22",borderRadius:5,padding:5}}>
                  {[["drivers","👤 DRIVERS"],["constructors","🏗️ CONSTRUCTORS"],["history","📋 RACE HISTORY"],["chaos","💥 CHAOS BOARD"]].map(([k,l])=>(
                    <button key={k} onClick={()=>setChampTab(k)} style={{flex:1,background:champTab===k?"#2A2A30":"transparent",color:champTab===k?"#F0F0F0":"#899",border:`1px solid ${champTab===k?"#778":"transparent"}`,padding:"8px 0",cursor:"pointer",fontFamily:"inherit",fontSize:14,fontWeight:700,letterSpacing:1.5,borderRadius:3,transition:"all 0.15s"}}>{l}</button>
                  ))}
                </div>

                {champTab==="drivers"&&(
                  <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(340px,1fr))",gap:5,maxHeight:620,overflowY:"auto"}}>
                    {getStandings().map((s,i)=>{
                      const team=teams.find(t=>t.id===s.driver.teamId);
                      return(
                        <div key={s.driver.id} style={{display:"flex",alignItems:"center",gap:10,padding:"11px 14px",background:i<3&&s.pts>0?"#181810":"#161618",border:`1px solid ${i<3&&s.pts>0?"#FFC90622":"#1E1E22"}`,borderLeft:`3px solid ${team?.color||"#899"}`,borderRadius:3,opacity:s.pts===0?0.45:1}}>
                          <div style={{width:30,height:30,display:"flex",alignItems:"center",justifyContent:"center",background:i===0&&s.pts>0?"#FFC906":i===1&&s.pts>0?"#aaa":i===2&&s.pts>0?"#CD7F32":"transparent",color:i<3&&s.pts>0?"#000":"#bbb",fontSize:13,fontWeight:700,borderRadius:2,border:!(i<3&&s.pts>0)?"1px solid #2A2A30":"none",flexShrink:0}}>{i+1}</div>
                          <div style={{flex:1,minWidth:0}}>
                            <div style={{fontSize:16,fontWeight:700}}>{s.driver.flag} {s.driver.name}</div>
                            <div style={{fontSize:12,color:team?.color||"#aaa",letterSpacing:1.5}}>{team?.name||""}{s.wins>0?` · ${s.wins} WIN${s.wins>1?"S":""}`:""}</div>
                            {s.sprintPts>0&&<div style={{fontSize:12,color:"#899",marginTop:1}}>🏁 {s.racePts} · ⚡ {s.sprintPts}</div>}
                          </div>
                          <div style={{textAlign:"right",flexShrink:0}}>
                            <div style={{fontSize:22,fontWeight:900,color:i===0&&s.pts>0?"#FFC906":i<3&&s.pts>0?"#aaa":s.pts>0?"#aaa":"#bbb",fontFamily:"monospace"}}>{s.pts}</div>
                            <div style={{fontSize:11,color:"#778",letterSpacing:0.5}}>PTS</div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                {champTab==="constructors"&&(
                  <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(340px,1fr))",gap:6}}>
                    {getConstructorStandings().map((s,i)=>(
                      <div key={s.team.id} style={{background:i<3&&s.pts>0?"#181810":"#161618",border:`1px solid ${i<3&&s.pts>0?"#FFC90622":"#1E1E22"}`,borderLeft:`4px solid ${s.team.color}`,borderRadius:3,padding:"14px 16px",opacity:s.pts===0?0.45:1}}>
                        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:8}}>
                          <div style={{width:32,height:32,display:"flex",alignItems:"center",justifyContent:"center",background:i===0&&s.pts>0?"#FFC906":i===1&&s.pts>0?"#aaa":i===2&&s.pts>0?"#CD7F32":"transparent",color:i<3&&s.pts>0?"#000":"#bbb",fontSize:14,fontWeight:700,borderRadius:2,border:!(i<3&&s.pts>0)?"1px solid #2A2A30":"none",flexShrink:0}}>{i+1}</div>
                          <div style={{flex:1,minWidth:0}}>
                            <div style={{display:"flex",alignItems:"center",gap:7}}>
                              <div style={{background:s.team.color,color:s.team.tc||"#fff",fontSize:12,fontWeight:700,padding:"2px 6px",letterSpacing:1.5,borderRadius:2}}>{s.team.abbr}</div>
                              <div style={{fontSize:17,fontWeight:700}}>{s.team.name}</div>
                            </div>
                            <div style={{fontSize:12,color:"#899",marginTop:2}}>⚙️ {s.team.engine}{s.wins>0?` · ${s.wins} WIN${s.wins>1?"S":""}`:""}</div>
                          </div>
                          <div style={{textAlign:"right",flexShrink:0}}>
                            <div style={{fontSize:26,fontWeight:900,color:i===0&&s.pts>0?"#FFC906":i<3&&s.pts>0?"#aaa":s.pts>0?"#aaa":"#bbb",fontFamily:"monospace"}}>{s.pts}</div>
                            <div style={{fontSize:11,color:"#778",letterSpacing:0.5}}>PTS</div>
                          </div>
                        </div>
                        <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:6}}>
                          {s.drivers.map(d=>{
                            let dPts=0; championship.forEach(r=>{dPts+=(r.raceResults?.[d.id]||0)+(r.sprintResults?.[d.id]||0);});
                            return <span key={d.id} style={{fontSize:13,color:dPts>0?"#ccc":"#778"}}>{d.flag} {d.name.split(" ").pop()} <span style={{color:s.team.color,fontWeight:700}}>{dPts}</span></span>;
                          })}
                        </div>
                        {s.sprintPts>0&&<div style={{fontSize:12,color:"#899"}}>🏁 {s.racePts} race · ⚡ {s.sprintPts} sprint</div>}
                        <div style={{marginTop:6,height:3,background:"#1A1A1A",borderRadius:2}}>
                          <div style={{height:3,width:`${getConstructorStandings()[0]?.pts>0?(s.pts/getConstructorStandings()[0].pts)*100:0}%`,background:s.team.color,borderRadius:2}}/>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {champTab==="history"&&(
                  selectedRound&&championship.find(x=>x.id===selectedRound)
                    ?<RoundDetail r={championship.find(x=>x.id===selectedRound)} onBack={()=>setSelectedRound(null)}/>
                    :(
                    <div style={{maxHeight:620,overflowY:"auto"}}>
                      {championship.length===0&&(
                        <div style={{padding:"40px",textAlign:"center",color:"#778",fontSize:14,letterSpacing:1}}>
                          No rounds saved yet. Complete a race and hit 💾 SAVE TO CHAMPIONSHIP.
                        </div>
                      )}
                      {[...championship].reverse().map((r)=>(
                        <div key={r.id} onClick={()=>setSelectedRound(r.id)}
                          className="hov" style={{background:"#161618",border:"1px solid #1E1E22",borderRadius:4,padding:"14px 16px",marginBottom:6,cursor:"pointer",transition:"background 0.15s"}}>
                          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4}}>
                            <span style={{fontSize:13,color:"#899",letterSpacing:1.5}}>ROUND {r.round}</span>
                            <div style={{display:"flex",gap:6,alignItems:"center"}}>
                              {r.hasSprint&&<span style={{fontSize:11,color:"#FFC906",background:"#FFC90620",padding:"1px 5px",borderRadius:2,fontWeight:700}}>⚡ SPRINT</span>}
                              <span style={{fontSize:11,color:"#555",letterSpacing:1}}>VIEW →</span>
                            </div>
                          </div>
                          <div style={{fontSize:17,fontWeight:700}}>{r.trackFlag} {r.trackName}</div>
                          {r.sprintWinner&&(
                            <div style={{marginTop:6,padding:"5px 8px",background:"#FFC90610",border:"1px solid #FFC90622",borderLeft:"3px solid #FFC906",borderRadius:"0 3px 3px 0"}}>
                              <div style={{fontSize:11,color:"#FFC906",fontWeight:700,letterSpacing:1.5,marginBottom:2}}>⚡ SPRINT WINNER</div>
                              <div style={{display:"flex",gap:4,flexWrap:"wrap"}}>
                                {r.sprintTop8?.slice(0,4).map((x,xi)=>(
                                  <span key={xi} style={{fontSize:12,color:xi===0?"#FFC906":"#bbb",fontWeight:xi===0?700:400}}>
                                    {xi===0?"🏆":""}{x.name} <span style={{color:"#FFC906",opacity:0.7}}>+{x.pts}</span>{xi<3?" ·":""}
                                  </span>
                                ))}
                              </div>
                            </div>
                          )}
                          <div style={{display:"flex",gap:6,marginTop:6,flexWrap:"wrap"}}>
                            {r.podium?.map((n,pi)=>(
                              <span key={pi} style={{fontSize:13,background:pi===0?"#FFC90620":pi===1?"#88888820":"#CD7F3220",color:pi===0?"#FFC906":pi===1?"#aaa":"#CD7F32",padding:"2px 7px",borderRadius:2,fontWeight:700}}>
                                {pi===0?"🥇":pi===1?"🥈":"🥉"} {n}
                              </span>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                    )
                )}

                {champTab==="chaos"&&(()=>{
                  // Aggregate chaos stats across all saved rounds
                  const totals={totalDNFs:0,crashDNFs:0,mechanicalDNFs:0,safetyCars:0,vscs:0,redFlags:0,timePenalties:0,wetRaces:0};
                  const dnfTally={};   // driverName -> count
                  const penTally={};   // driverName -> total seconds
                  const chaosRounds=[];
                  championship.forEach(r=>{
                    const cs=r.chaosStats;
                    if(!cs) return;
                    totals.totalDNFs+=cs.totalDNFs||0;
                    totals.crashDNFs+=cs.crashDNFs||0;
                    totals.mechanicalDNFs+=cs.mechanicalDNFs||0;
                    totals.safetyCars+=cs.safetyCars||0;
                    totals.vscs+=cs.vscs||0;
                    totals.redFlags+=cs.redFlags||0;
                    totals.timePenalties+=cs.timePenalties||0;
                    if(cs.isWet) totals.wetRaces++;
                    (cs.dnfDrivers||[]).forEach(d=>{dnfTally[d.name]=(dnfTally[d.name]||0)+1;});
                    (cs.penaltyDrivers||[]).forEach(d=>{penTally[d.name]=(penTally[d.name]||0)+(d.secs||0);});
                    chaosRounds.push({round:r.round,track:r.trackName,flag:r.trackFlag,...cs});
                  });
                  const dnfLeague=Object.entries(dnfTally).sort((a,b)=>b[1]-a[1]).slice(0,10);
                  const penLeague=Object.entries(penTally).sort((a,b)=>b[1]-a[1]).slice(0,8);
                  const totalRaces=championship.filter(r=>r.chaosStats).length;
                  // Funny commentary lines
                  const chaos=totals.totalDNFs;
                  const chaosLine=chaos===0?"A miraculously boring season. Everyone drove in circles without incident.":chaos<=3?"Suspiciously clean. The stewards had nothing to do.":chaos<=8?"A proper season — tyres flew, engines cried.":chaos<=15?"Carnage. The medical car earned its contract.":chaos<=25?"This was not a race, it was a demolition derby.":"The FIA has filed for emotional damages.";
                  const scLine=totals.safetyCars===0?"Not a single safety car. Either very skilled or very lucky.":totals.safetyCars<=3?"The safety car driver almost got a podium himself.":totals.safetyCars<=8?"The safety car put in more laps than some of the back markers.":"The safety car started requesting prize money.";
                  const rfLine=totals.redFlags===0?"Zero red flags. Race control were bored stiff.":totals.redFlags===1?"One red flag. Someone had a very bad day.":totals.redFlags<=3?"Multiple red flags. The barriers took a beating.":"Race control declared a state of emergency.";
                  const tile=(icon,label,val,sub,col)=>(
                    <div style={{background:"#161618",border:`1px solid ${col}33`,borderTop:`3px solid ${col}`,borderRadius:4,padding:"14px 16px",textAlign:"center"}}>
                      <div style={{fontSize:28,marginBottom:4}}>{icon}</div>
                      <div style={{fontSize:30,fontWeight:900,color:col,fontFamily:"monospace"}}>{val}</div>
                      <div style={{fontSize:12,color:"#778",letterSpacing:1.5,marginTop:2}}>{label}</div>
                      {sub&&<div style={{fontSize:11,color:"#556",marginTop:3}}>{sub}</div>}
                    </div>
                  );
                  return(
                    <div>
                      {/* Funny headline */}
                      <div style={{background:"#111115",border:"1px solid #1E1E22",borderLeft:"4px solid #FF4444",borderRadius:4,padding:"12px 16px",marginBottom:16,fontStyle:"italic",color:"#ccc",fontSize:14}}>
                        💬 "{chaosLine}"
                      </div>

                      {/* Big number tiles */}
                      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(130px,1fr))",gap:8,marginBottom:16}}>
                        {tile("💥","TOTAL DNFs",totals.totalDNFs,`${totalRaces} race${totalRaces!==1?"s":""}`,  "#FF4444")}
                        {tile("🔧","MECHANICALS",totals.mechanicalDNFs,"engine/hydraulics/gearbox","#FF8800")}
                        {tile("🏎️💢","CRASH DNFs",totals.crashDNFs,"barrier introductions","#FF6644")}
                        {tile("🚗","SAFETY CARS",totals.safetyCars,"full SC deployments","#FFC906")}
                        {tile("🟡","VSCS",totals.vscs,"virtual safety cars","#FFDD44")}
                        {tile("🔴","RED FLAGS",totals.redFlags,"race suspensions","#FF2222")}
                        {tile("🌧️","WET RACES",totals.wetRaces,`of ${totalRaces} rounds`,"#4488FF")}
                        {tile("⚠️","PENALTIES",totals.timePenalties,"time penalties issued","#BB66FF")}
                      </div>

                      {/* Commentary sub-lines */}
                      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:16}}>
                        <div style={{background:"#111115",border:"1px solid #FFC90622",borderRadius:4,padding:"10px 14px",fontSize:13,color:"#aaa",fontStyle:"italic"}}>🚗 {scLine}</div>
                        <div style={{background:"#111115",border:"1px solid #FF444422",borderRadius:4,padding:"10px 14px",fontSize:13,color:"#aaa",fontStyle:"italic"}}>🔴 {rfLine}</div>
                      </div>

                      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
                        {/* DNF shame board */}
                        <div>
                          <div style={{fontSize:12,color:"#778",letterSpacing:2,marginBottom:8}}>🏴 DNF HALL OF SHAME</div>
                          {dnfLeague.length===0&&<div style={{fontSize:13,color:"#445",padding:"10px 0"}}>No DNFs yet — astounding.</div>}
                          {dnfLeague.map(([name,count],i)=>(
                            <div key={name} style={{display:"flex",alignItems:"center",gap:8,padding:"7px 10px",background:i===0?"#1A0A0A":"#111115",border:`1px solid ${i===0?"#FF444433":"#1E1E22"}`,borderLeft:`3px solid ${i===0?"#FF4444":i===1?"#FF8800":"#554"}`,borderRadius:3,marginBottom:4}}>
                              <div style={{fontSize:13,color:"#556",width:18}}>{i+1}</div>
                              <div style={{flex:1,fontSize:14,fontWeight:700}}>{name}</div>
                              <div style={{fontSize:16,fontWeight:900,color:i===0?"#FF4444":"#FF8800",fontFamily:"monospace"}}>{count}</div>
                              <div style={{fontSize:10,color:"#445",letterSpacing:1}}>DNF{count!==1?"s":""}</div>
                            </div>
                          ))}
                          {dnfLeague.length>0&&dnfLeague[0][1]>=3&&(
                            <div style={{fontSize:12,color:"#FF6644",fontStyle:"italic",marginTop:6}}>
                              😬 {dnfLeague[0][0]} might want to check their contract.
                            </div>
                          )}
                        </div>

                        {/* Penalty board */}
                        <div>
                          <div style={{fontSize:12,color:"#778",letterSpacing:2,marginBottom:8}}>⚠️ STEWARDS' FAVOURITES</div>
                          {penLeague.length===0&&<div style={{fontSize:13,color:"#445",padding:"10px 0"}}>No penalties issued. The stewards are confused.</div>}
                          {penLeague.map(([name,secs],i)=>(
                            <div key={name} style={{display:"flex",alignItems:"center",gap:8,padding:"7px 10px",background:i===0?"#140A1A":"#111115",border:`1px solid ${i===0?"#BB66FF33":"#1E1E22"}`,borderLeft:`3px solid ${i===0?"#BB66FF":i===1?"#AA55EE":"#554"}`,borderRadius:3,marginBottom:4}}>
                              <div style={{fontSize:13,color:"#556",width:18}}>{i+1}</div>
                              <div style={{flex:1,fontSize:14,fontWeight:700}}>{name}</div>
                              <div style={{fontSize:16,fontWeight:900,color:i===0?"#BB66FF":"#AA55EE",fontFamily:"monospace"}}>{secs}s</div>
                              <div style={{fontSize:10,color:"#445",letterSpacing:1}}>PEN</div>
                            </div>
                          ))}
                          {penLeague.length>0&&penLeague[0][1]>=15&&(
                            <div style={{fontSize:12,color:"#BB66FF",fontStyle:"italic",marginTop:6}}>
                              🕵️ {penLeague[0][0]} is on first-name terms with the stewards.
                            </div>
                          )}
                        </div>
                      </div>

                      {/* Per-round chaos breakdown */}
                      {chaosRounds.length>0&&(
                        <div style={{marginTop:16}}>
                          <div style={{fontSize:12,color:"#778",letterSpacing:2,marginBottom:8}}>📊 ROUND-BY-ROUND CHAOS</div>
                          <div style={{display:"grid",gap:4}}>
                            {chaosRounds.map(cr=>(
                              <div key={cr.round} style={{display:"flex",alignItems:"center",gap:10,padding:"8px 12px",background:"#111115",border:"1px solid #1E1E22",borderRadius:3}}>
                                <div style={{fontSize:13,color:"#556",width:28,flexShrink:0}}>R{cr.round}</div>
                                <div style={{fontSize:14,fontWeight:700,flex:1}}>{cr.flag} {cr.track}</div>
                                <div style={{display:"flex",gap:8,flexShrink:0,flexWrap:"wrap",justifyContent:"flex-end"}}>
                                  {cr.totalDNFs>0&&<span style={{fontSize:11,color:"#FF4444",background:"#FF444418",padding:"1px 6px",borderRadius:2,fontWeight:700}}>💥 {cr.totalDNFs} DNF</span>}
                                  {cr.safetyCars>0&&<span style={{fontSize:11,color:"#FFC906",background:"#FFC90618",padding:"1px 6px",borderRadius:2,fontWeight:700}}>🚗 ×{cr.safetyCars}</span>}
                                  {cr.vscs>0&&<span style={{fontSize:11,color:"#FFDD44",background:"#FFDD4418",padding:"1px 6px",borderRadius:2,fontWeight:700}}>🟡 ×{cr.vscs}</span>}
                                  {cr.redFlags>0&&<span style={{fontSize:11,color:"#FF2222",background:"#FF222218",padding:"1px 6px",borderRadius:2,fontWeight:700}}>🔴 RF</span>}
                                  {cr.timePenalties>0&&<span style={{fontSize:11,color:"#BB66FF",background:"#BB66FF18",padding:"1px 6px",borderRadius:2,fontWeight:700}}>⚠️ {cr.timePenalties}×pen</span>}
                                  {cr.isWet&&<span style={{fontSize:11,color:"#4488FF",background:"#4488FF18",padding:"1px 6px",borderRadius:2,fontWeight:700}}>🌧️</span>}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })()}
              </>
            )}
          </div>
        )}
      </div>


        
        {view==="guide"&&(
          <div style={{animation:"fadeIn 0.2s ease",maxWidth:860,margin:"0 auto"}}>

            {/* Header */}
            <div style={{marginBottom:28,textAlign:"center"}}>
              <div style={{fontSize:28,fontWeight:700,letterSpacing:3,marginBottom:6}}>📖 HOW TO USE F1 SIM</div>
              <div style={{fontSize:14,color:"#778",letterSpacing:1.5}}>2027 Formula 1 Season Simulator — Quick Start Guide</div>
            </div>

            {/* Quick start */}
            <div style={{background:"#0D0D14",border:"1px solid #E8002D33",borderLeft:"4px solid #E8002D",borderRadius:"0 6px 6px 0",padding:"18px 22px",marginBottom:20}}>
              <div style={{fontSize:13,color:"#E8002D",fontWeight:700,letterSpacing:2,marginBottom:12}}>🚦 QUICK START — YOUR FIRST RACE IN 4 STEPS</div>
              {[
                ["1","Open GARAGE","Check your drivers and teams. Each driver has stats (Pace, Consistency, Wet, Overtaking, Defence, Experience), a Driving Style, and up to 3 Rivals. Edit anything by clicking a card."],
                ["2","Pick a Track","Hit TRACKS in the nav bar. Choose any of the 24 circuits on the 2027 calendar. Sprint weekend tracks are marked ⚡."],
                ["3","Run Qualifying","Click SIMULATE QUALIFYING. Watch Q1 → Q2 → Q3 unfold with live events (yellow flags, traffic, rival battles). Each session gets its own report."],
                ["4","Race!","Hit START RACE from the qualifying screen. The race sim runs pit stops, safety cars, DNFs and position battles. Save the result to the 🏆 CHAMP tab to build your season."],
              ].map(([n,title,desc])=>(
                <div key={n} style={{display:"flex",gap:14,marginBottom:n==="4"?0:14,alignItems:"flex-start"}}>
                  <div style={{width:28,height:28,background:"#E8002D",color:"#fff",borderRadius:3,display:"flex",alignItems:"center",justifyContent:"center",fontSize:14,fontWeight:900,flexShrink:0}}>{n}</div>
                  <div>
                    <div style={{fontSize:14,fontWeight:700,marginBottom:3}}>{title}</div>
                    <div style={{fontSize:13,color:"#aaa",lineHeight:1.7}}>{desc}</div>
                  </div>
                </div>
              ))}
            </div>

            {/* Two-column sections */}
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14,marginBottom:14}}>

              {/* Accuracy mode */}
              <div style={{background:"#111115",border:"1px solid #1E1E22",borderRadius:6,padding:"16px 18px"}}>
                <div style={{fontSize:12,color:"#FFC906",fontWeight:700,letterSpacing:2,marginBottom:12}}>⟳ ACCURACY MODE</div>
                <p style={{fontSize:13,color:"#aaa",lineHeight:1.75,margin:"0 0 10px 0"}}>The <strong style={{color:"#F0F0F0"}}>ACCURACY</strong> selector (top-right of the nav bar) controls how many times each session is simulated before showing you the result.</p>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6}}>
                  {[["×1","Pure random — full drama, any result possible","#778"],["×5","Light smoothing — still surprising","#aaa"],["×10","Recommended — statistically solid","#FFC906"],["×20","Most accurate — closest to real pace","#44CC88"]].map(([l,d,c])=>(
                    <div key={l} style={{background:"#161618",borderRadius:4,padding:"8px 10px",border:`1px solid ${c}33`}}>
                      <div style={{fontSize:13,fontWeight:700,color:c,marginBottom:3}}>{l}</div>
                      <div style={{fontSize:11,color:"#778",lineHeight:1.5}}>{d}</div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Driving styles */}
              <div style={{background:"#111115",border:"1px solid #1E1E22",borderRadius:6,padding:"16px 18px"}}>
                <div style={{fontSize:12,color:"#FF8844",fontWeight:700,letterSpacing:2,marginBottom:12}}>🏎️ DRIVING STYLES</div>
                <p style={{fontSize:13,color:"#aaa",lineHeight:1.75,margin:"0 0 10px 0"}}>Each driver has one of 8 styles that modifies their stats. Change it in the driver edit modal.</p>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:5}}>
                  {[["🔥 Aggressive","More overtakes, higher DNF risk"],["🎯 Smooth","Tyre saver, consistent finisher"],["⚡ Qualifier","Fastest in Q3, struggles in race"],["🛡️ Defender","Hard to pass, slow to pass others"],["🚀 Charger","Thrives from low grid positions"],["♟️ Strategist","Undercuts, SC timing, experience"],["🔬 Technical","Wet weather ace, precision circuits"],["⚙️ Ironman","Rarely retires, always in the points"]].map(([l,d])=>(
                    <div key={l} style={{fontSize:12,lineHeight:1.5}}>
                      <div style={{color:"#F0F0F0",fontWeight:700,marginBottom:1}}>{l}</div>
                      <div style={{color:"#778"}}>{d}</div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Team strategies */}
              <div style={{background:"#111115",border:"1px solid #1E1E22",borderRadius:6,padding:"16px 18px"}}>
                <div style={{fontSize:12,color:"#44CC88",fontWeight:700,letterSpacing:2,marginBottom:12}}>♟️ TEAM STRATEGIES</div>
                <p style={{fontSize:13,color:"#aaa",lineHeight:1.75,margin:"0 0 10px 0"}}>Each team has a race strategy that affects their pace, pit timing, DNF risk, and safety car reaction. Change it in the team edit modal.</p>
                <div style={{display:"grid",gridTemplateColumns:"1fr",gap:5}}>
                  {[["🎯 One-Stop Master","Preserve tyres, maximise track position"],["🔥 Aggressive 2-Stop","Always on fresh rubber, higher DNF risk"],["⚔️ Undercut Specialist","First to pit, force rivals to react"],["♟️ Overcut Gamble","Stay out, bank track position"],["💧 Fuel Saving","Slow start, blistering final stint"],["🚗 Safety Car Hunter","Pit early, pray for the SC to close the gap"],["🏦 Tyre Banker","Used tyres first, then fresh rubber surge"],["🔄 Reactive","No fixed plan — responds to whatever the race throws"]].map(([l,d])=>(
                    <div key={l} style={{display:"flex",gap:8,padding:"5px 0",borderBottom:"1px solid #1E1E22"}}>
                      <div style={{fontSize:12,fontWeight:700,color:"#F0F0F0",minWidth:160}}>{l}</div>
                      <div style={{fontSize:12,color:"#778"}}>{d}</div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Track variables */}
              <div style={{background:"#111115",border:"1px solid #1E1E22",borderRadius:6,padding:"16px 18px"}}>
                <div style={{fontSize:12,color:"#4488FF",fontWeight:700,letterSpacing:2,marginBottom:12}}>🏁 TRACK VARIABLES</div>
                <p style={{fontSize:13,color:"#aaa",lineHeight:1.75,margin:"0 0 10px 0"}}>Every circuit has 10 variables that affect the simulation. These are shown on each track card.</p>
                <div style={{display:"grid",gridTemplateColumns:"1fr",gap:5}}>
                  {[["OVT","How easy it is to overtake (inversely scaled from Od)"],["DEG","Tyre degradation rate — high = more pit stops"],["WET","Chance of wet-weather conditions"],["DRS","Number of DRS zones — more = better for overtaking styles"],["Corners","Number of corners — shapes the circuit character"],["Lap length","Circuit length in km — affects sprint lap count"],["Altitude ⛰","High altitude (e.g. Mexico 2285m) reduces engine power"],["Night 🌙","Night races favour experienced drivers"],["Street 🏙","Street circuits boost defence and experience stats"],["Abrasive 🔴","High abrasion surfaces punish low-consistency drivers"]]
                    .map(([l,d])=>(
                    <div key={l} style={{display:"flex",gap:8,padding:"5px 0",borderBottom:"1px solid #1E1E22"}}>
                      <div style={{fontSize:12,fontWeight:700,color:"#F0F0F0",minWidth:90}}>{l}</div>
                      <div style={{fontSize:12,color:"#778",lineHeight:1.5}}>{d}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Features full-width row */}
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:14,marginBottom:14}}>

              {/* Rivalries */}
              <div style={{background:"#111115",border:"1px solid #E8002D22",borderRadius:6,padding:"16px 18px"}}>
                <div style={{fontSize:12,color:"#E8002D",fontWeight:700,letterSpacing:2,marginBottom:10}}>⚔️ RIVALRIES</div>
                <p style={{fontSize:13,color:"#aaa",lineHeight:1.75,margin:0}}>Set up to <strong style={{color:"#F0F0F0"}}>3 rivals</strong> per driver in their edit modal. Rivalries trigger special commentary moments in qualifying sessions, sprints and races — yellow flag drama, sector battles, radio tension and more. Default rivalries mirror real 2027 storylines.</p>
              </div>

              {/* Pre-season testing */}
              <div style={{background:"#111115",border:"1px solid #4466FF22",borderRadius:6,padding:"16px 18px"}}>
                <div style={{fontSize:12,color:"#6688FF",fontWeight:700,letterSpacing:2,marginBottom:10}}>🔬 PRE-SEASON TESTING</div>
                <p style={{fontSize:13,color:"#aaa",lineHeight:1.75,margin:0}}>Two tests before the season: <strong style={{color:"#F0F0F0"}}>Barcelona (Feb 10–12)</strong> and <strong style={{color:"#F0F0F0"}}>Bahrain (Feb 24–26)</strong>. Each generates 3 days of data with qualifying sim times, long-run pace, lap counts, technical issues and a Sky Sports-style narrative report per day. Bahrain is the closer — it tells you who is really fast.</p>
              </div>

              {/* Multi-sim */}
              <div style={{background:"#111115",border:"1px solid #44CC8822",borderRadius:6,padding:"16px 18px"}}>
                <div style={{fontSize:12,color:"#44CC88",fontWeight:700,letterSpacing:2,marginBottom:10}}>📊 MULTI-SIM</div>
                <p style={{fontSize:13,color:"#aaa",lineHeight:1.75,margin:0}}>The <strong style={{color:"#F0F0F0"}}>MULTI-SIM</strong> tab runs ×5–×20 full race weekends and shows <strong style={{color:"#F0F0F0"}}>probability statistics</strong>: win%, podium%, pole%, DNF%, average finishing position, and total championship points. Use it to understand the most probable outcome before writing a race narrative.</p>
              </div>
            </div>

            {/* Commentary + Championship */}
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14,marginBottom:14}}>

              <div style={{background:"#111115",border:"1px solid #CC44FF22",borderRadius:6,padding:"16px 18px"}}>
                <div style={{fontSize:12,color:"#CC44FF",fontWeight:700,letterSpacing:2,marginBottom:10}}>🎙️ CROFT & BRUNDLE COMMENTARY</div>
                <p style={{fontSize:13,color:"#aaa",lineHeight:1.75,margin:"0 0 10px 0"}}>After a race, go to the <strong style={{color:"#F0F0F0"}}>COMMENTARY</strong> tab. Enter your <strong style={{color:"#F0F0F0"}}>Anthropic API key</strong> (free at console.anthropic.com) and hit Generate. The AI writes a full Sky Sports broadcast script across 7 stages — Lights Out, Early Running, Pit Window, Mid-Race, Midfield Melee, Closing, Podium — with David Croft's excitable play-by-play and Martin Brundle's technical insight. Lap-accurate, rivalry-aware, strategy-referenced.</p>
                <div style={{background:"#0D0D12",padding:"8px 12px",borderRadius:4,border:"1px solid #CC44FF22"}}>
                  <div style={{fontSize:11,color:"#CC44FF",fontWeight:700,marginBottom:3}}>HOW TO GET AN API KEY</div>
                  <div style={{fontSize:12,color:"#778",lineHeight:1.6}}>1. Visit console.anthropic.com → Sign up (free)<br/>2. API Keys → Create Key → Copy it<br/>3. Paste it in the Commentary tab<br/>Stored in your browser only — never shared.</div>
                </div>
              </div>

              <div style={{background:"#111115",border:"1px solid #FFC90622",borderRadius:6,padding:"16px 18px"}}>
                <div style={{fontSize:12,color:"#FFC906",fontWeight:700,letterSpacing:2,marginBottom:10}}>🏆 CHAMPIONSHIP TRACKER</div>
                <p style={{fontSize:13,color:"#aaa",lineHeight:1.75,margin:"0 0 10px 0"}}>After every race, hit <strong style={{color:"#F0F0F0"}}>💾 SAVE TO CHAMPIONSHIP</strong> from the race screen. This freezes a complete snapshot of qualifying, sprint (if applicable) and race results. The championship tab tracks:</p>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                  {[["👤 Drivers","Points, wins, podiums, fastest laps per driver with per-race breakdown"],["🏗️ Constructors","Team totals with per-driver contribution and championship bar"],["📋 Race History","Every saved round — click VIEW to see the frozen Q1/Q2/Q3, sprint and race results"],["↺ Undo / Reset","Remove the last round or wipe the entire season and start fresh"]].map(([l,d])=>(
                    <div key={l} style={{background:"#161618",padding:"8px 10px",borderRadius:4}}>
                      <div style={{fontSize:12,fontWeight:700,color:"#F0F0F0",marginBottom:3}}>{l}</div>
                      <div style={{fontSize:11,color:"#778",lineHeight:1.5}}>{d}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Tips */}
            <div style={{background:"#111115",border:"1px solid #1E1E22",borderRadius:6,padding:"16px 18px",marginBottom:14}}>
              <div style={{fontSize:12,color:"#aaa",fontWeight:700,letterSpacing:2,marginBottom:12}}>💡 TIPS & TRICKS</div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10}}>
                {[
                  ["Use ×10 Accuracy","The sweet spot between speed and realism. ×1 for dramatic single-race stories, ×10 for accurate results."],
                  ["Sprint weekends","6 tracks have sprints: China, Miami, Austria, USA, Brazil, Qatar. Run qualifying → sprint → race to get the full points haul."],
                  ["Bad weather","Wet track variable above 40% means rain is genuinely possible. Drivers with high Wet stats (Technical style) become top contenders."],
                  ["Edit your roster","Click any driver or team card in the Garage to change stats, style, strategy, rivals, good/bad tracks. Build your own 2027 alternate universe."],
                  ["Championship snapshots","Saved rounds are fully frozen — you can always go back and check the exact Q3 grid or full race classification for Round 3."],
                  ["Multi-Sim before writing","Run ×20 on the Multi-Sim tab to find out who realistically should win, then use a single ×1 race for the unpredictable story moment."],
                ].map(([t,d])=>(
                  <div key={t} style={{background:"#161618",padding:"10px 12px",borderRadius:4,borderLeft:"3px solid #E8002D"}}>
                    <div style={{fontSize:12,fontWeight:700,color:"#F0F0F0",marginBottom:4}}>{t}</div>
                    <div style={{fontSize:12,color:"#778",lineHeight:1.6}}>{d}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* Version footer */}
            <div style={{textAlign:"center",padding:"16px 0",borderTop:"1px solid #1E1E22"}}>
              <div style={{fontSize:12,color:"#2A2A30",letterSpacing:2}}>F1 SIM — 2027 SEASON · v2027.1 · Built for F1 fans & RPers</div>
            </div>

          </div>
        )}

        {modal&&<EditModal type={modal.type} data={modal.data} teams={teams} drivers={drivers} onSave={modal.type==="driver"?saveDriver:saveTeam} onClose={()=>setModal(null)} teamBudgets={teamBudgets} currentRound={championship.length+1} onSetBudget={setBudgetCap}/>}
    </div>
    </ErrorBoundary>
  );
}
