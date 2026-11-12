/* F1 SIM v1.0.9 (build f1sim-1.0.9): a Formula 1 league. Race engine, Formula Racing V3.0 adapter, app core, the grid and race weekends, the paddock. */
/* =====================================================================
   F1 SIM race engine.
   Pure and deterministic, in the same pattern as CombatEngine: a seed,
   the starting state and the calls made each lap always give the same
   race, so every Grand Prix can be replayed, paused for strategy calls,
   resumed and audited. No I/O. The race state is plain JSON, so it can be
   saved to the docs table between laps and picked up by anyone.

   API
     qualify({ circuit, entries, weather, seed, rules })      -> { grid, results, log }
     createRace({ circuit, entries, grid, weather, seed, rules }) -> state
     stepLap(state, calls)                                     -> { state, log }
     runTo(state, lap, callsByLap)                             -> { state, log }
     classify(state)                                           -> results with points
     carScore(car, circuit)                                    -> 0..100

   Calls (all optional; with none, the AI strategist runs every car)
     { entry, type: 'box', compound }            pit at the end of this lap
     { entry, type: 'mode', value }              push | standard | manage
     { entry, type: 'plan', stops: [{ lap, compound }] }
     { entry, type: 'strategy', name, stops, wetCall, dryCall, useSC }   switch to another plan
     { entry, type: 'manual', value: true }      AI stops making pit calls for this car
     { team,  type: 'order', value }             hold | swap | none
     { entry, type: 'refuseOrder' }              the driver ignores the current team order
     { entry, type: 'moment', kind, choice }     a driver moment for the coming lap:
         attack: outside | inside | boost | wait    defend: cover | hold | concede
         restart: jump | safe          (momentOdds() gives the odds shown to the player)

   Optional entry fields (all default to neutral)
     driver.overtaking / driver.defense   split attack and defence (else racecraft for both)
     driver.experience / driver.mental    fewer mistakes under pressure
     car.pitSpeed / car.tyreLife          crew speed and how kind the car is to its tyres
     paceAdj / qualiAdj                   seconds per lap, e.g. a driver's good or bad tracks
     ai: { stretch, scPit, undercut }     the AI strategist's personality for this car
     planned, plan, ai.wetCall/dryCall    a team's own plan: stops on set laps, and when to
                                          go to wet tyres (early | normal | late) and back
     ai.useSC                             pit under a safety car if a planned stop is near
     plans: [{ name, stops, wetCall, dryCall, useSC }]   the car's plans, for triggers to switch
     triggers: [{ when, n, from, to, action, plan, mode, chance }]
         when: sc | rain | dry | lost | gained | wear      action: plan | mode | box
         Checked at the end of every lap; acted on with the given % chance, once each.
     approach: balanced | attacker | defender | tyres   drives the car's mode lap by lap
     startMode                            driving mode at the start
   ===================================================================== */
(function (root) {
  'use strict';

  var COMPOUNDS = {
    soft:   { label: 'Soft',         short: 'S', offset: 0.00, deg: 0.085, life: 16, wet: false },
    medium: { label: 'Medium',       short: 'M', offset: 0.45, deg: 0.055, life: 26, wet: false },
    hard:   { label: 'Hard',         short: 'H', offset: 0.85, deg: 0.035, life: 38, wet: false },
    inter:  { label: 'Intermediate', short: 'I', offset: 0.00, deg: 0.050, life: 30, wet: true },
    wet:    { label: 'Wet',          short: 'W', offset: 0.00, deg: 0.040, life: 35, wet: true }
  };
  var TRACK = ['dry', 'damp', 'wet'];
  /* Seconds lost per lap for each compound on a dry, damp or wet track. */
  var GRIP = { soft: [0, 4, 11], medium: [0, 4.5, 11.5], hard: [0, 5, 12], inter: [2.8, 0, 3.5], wet: [5.5, 1.8, 0] };
  var MODES = {
    push:     { label: 'Push',     pace: -0.30, deg: 1.45, risk: 1.6, energy: 4 },
    standard: { label: 'Standard', pace: 0,     deg: 1.00, risk: 1.0, energy: 12 },
    manage:   { label: 'Manage',   pace: 0.40,  deg: 0.65, risk: 0.6, energy: 20 }
  };
  var DEFAULTS = {
    points: [25, 18, 15, 12, 10, 8, 6, 4, 2, 1],
    qualifying: { q2: 16, q3: 10 },
    carCoef: 0.11,          // seconds per point of car score
    driverCoef: 0.035,      // seconds per point of driver pace
    setupCoef: 0.006,       // seconds per point of setup quality
    fuelEffect: 3.2,        // seconds slower on a full tank
    minGap: 0.35,           // closest a following car finishes a lap without passing
    overtake: { base: 0.015, pace: 0.2, racecraft: 0.003 },  // pass chance, scaled by the circuit's ease of overtaking
    dirtyAir: 0.25,         // seconds lost when right behind another car
    overtakeMode: { gap: 1.0, cost: 35, bonus: 0.07 },
    pitStop: { mean: 2.5, sd: 0.3, slowChance: 0.04 },
    scPace: 1.35, vscPace: 1.30, scBunch: 0.8,
    formSd: 0.25,           // weekend-to-weekend swing in a car's pace (s): set-up, track temperature, luck
    failureRate: 0.0025,    // per lap, scaled by (1 - reliability)
    crashRate: 0.0008, mistakeRate: 0.006,
    /* Engine eras. modeEnergy replaces how much each driving mode recharges (or drains) the battery;
       emptyBattery is the time lost on a lap run with a flat battery; noHybrid removes the battery boost. */
    modeEnergy: null, emptyBattery: 0, noHybrid: false,
    /* Race incidents: multipliers for each family (see INCIDENTS). */
    incidents: { crashes: 1, failures: 1, outside: 1 }, weatherEvents: true
  };

  /* ------------------------------------------------------------ randomness */
  function rng(seed) {                               // mulberry32, as in CombatEngine
    var a = seed >>> 0;
    return function () { a = (a + 0x6D2B79F5) | 0; var t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  function hashId(id) { var h = 2166136261; String(id).split('').forEach(function (ch) { h = Math.imul(h ^ ch.charCodeAt(0), 16777619); }); return h >>> 0; }
  /* The same car gets the same weekend form in qualifying and the race. */
  function weekendForm(seed, id, rules) { return round3(gauss(rng(mix(seed, hashId(id) % 100000, 5))) * rules.formSd); }
  function mix(seed, n, salt) { var h = (seed ^ Math.imul(n + 1, 0x9E3779B1) ^ Math.imul(salt + 7, 0x85EBCA6B)) >>> 0; h = Math.imul(h ^ (h >>> 16), 0x7FEB352D); return (h ^ (h >>> 15)) >>> 0; }
  function gauss(r) { var u = 1 - r(), v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
  var clamp = function (x, lo, hi) { return Math.max(lo, Math.min(hi, x)); };
  var round3 = function (x) { return Math.round(x * 1000) / 1000; };
  function merge(a, b) { var o = {}, k; for (k in a) o[k] = a[k]; for (k in (b || {})) o[k] = b[k]; return o; }

  /* ------------------------------------------------------------ pace model */
  function carScore(car, circuit) {
    var w = circuit.weights || { power: 1, aero: 1, grip: 1 }, s = (w.power || 0) + (w.aero || 0) + (w.grip || 0) || 1;
    return ((car.power || 0) * (w.power || 0) + (car.aero || 0) * (w.aero || 0) + (car.grip || 0) * (w.grip || 0)) / s;
  }
  /* Everything about a car and driver that doesn't change lap to lap. */
  function basePace(e, circuit, rules, track) {
    var d = e.driver;
    var t = circuit.baseLap
      - (carScore(e.car, circuit) - 85) * rules.carCoef
      - (d.pace - 85) * rules.driverCoef
      - ((e.setup == null ? 60 : e.setup) - 60) * rules.setupCoef;
    if (track > 0) t -= (d.wet - 85) * 0.04 * track;
    return t + (e.paceAdj || 0) + (e.form || 0);
  }
  function tyreLife(compound, e, circuit) {
    var carLife = (e.car && e.car.tyreLife != null) ? 1 + (e.car.tyreLife - 75) / 150 : 1;
    return COMPOUNDS[compound].life / (circuit.tyreStress || 1) * (0.85 + e.driver.tyreMgmt / 600) * carLife;
  }
  var attack = function (d) { return d.overtaking != null ? d.overtaking : d.racecraft; };
  var defend = function (d) { return d.defense != null ? d.defense : d.racecraft; };
  function composure(d) { return (1 + (70 - (d.experience == null ? 70 : d.experience)) / 150) * (1 + (7 - (d.mental == null ? 7 : d.mental)) * 0.06); }
  function tyreTime(tyre, e, circuit, track) {
    var c = COMPOUNDS[tyre.compound], life = tyreLife(tyre.compound, e, circuit);
    var t = (c.wet ? 0 : c.offset) + GRIP[tyre.compound][track] + tyre.wear * c.deg;
    if (tyre.wear > life) t += Math.pow(tyre.wear - life, 1.6) * 0.08;
    return t;
  }

  /* ------------------------------------------------------------ weather */
  function weatherPlan(weather, laps, seed) {
    weather = weather || { start: 'dry' };
    var plan = [], cur = TRACK.indexOf(weather.start || 'dry'), changes = {};
    if (cur < 0) cur = 0;
    (weather.changes || []).forEach(function (c) { changes[c.lap] = TRACK.indexOf(c.to); });
    if (weather.mode === 'variable') {
      var r = rng(mix(seed, 0, 99)), chance = weather.rainChance == null ? 0.5 : weather.rainChance;
      if (r() < chance) {
        var from = 5 + Math.floor(r() * (laps - 15)), len = 6 + Math.floor(r() * 18), peak = r() < 0.45 ? 2 : 1;
        changes[from] = 1; if (peak === 2) changes[from + 3] = 2;
        changes[Math.min(laps, from + len)] = 1; changes[Math.min(laps, from + len + 4)] = 0;
      }
    }
    for (var lap = 1; lap <= laps; lap++) { if (changes[lap] != null && changes[lap] >= 0) cur = changes[lap]; plan.push(cur); }
    return plan;
  }

  /* ------------------------------------------------------------ plans, triggers and race approaches */
  function switchPlan(car, p, s, log, why) {
    car.plan = (p.stops || []).filter(function (x) { return x.lap > s.lap; }).sort(function (a, b) { return a.lap - b.lap; });
    car.planned = true; car.planName = p.name || car.planName;
    car.ai = merge(car.ai || {}, { wetCall: p.wetCall || 'normal', dryCall: p.dryCall || 'normal', useSC: p.useSC !== false });
    log.push({ kind: 'trigger', ids: [car.id], text: car.driver.code + ': ' + why + ', so the team switches to ' + (p.name || 'another plan') });
  }
  var TRIGGER_WHY = { sc: 'safety car', rain: 'rain', dry: 'the track is drying', lost: 'places lost', gained: 'places gained', wear: 'tyres going off' };
  function checkTriggers(s, r, log, track, scNow) {
    var prev = s.lap > 1 ? s.track[s.lap - 2] : track, ord = order(s);
    running(s).forEach(function (car) {
      (car.triggers || []).forEach(function (t) {
        if (t.fired || (t.from && s.lap < t.from) || (t.to && s.lap > t.to)) return;
        var pos = ord.indexOf(car) + 1, life = tyreLife(car.tyre.compound, car, s.circuit), hit = false;
        if (t.when === 'sc') hit = scNow; else if (t.when === 'rain') hit = track > 0 && prev === 0; else if (t.when === 'dry') hit = track === 0 && prev > 0;
        else if (t.when === 'lost') hit = pos - car.grid >= (t.n || 3); else if (t.when === 'gained') hit = car.grid - pos >= (t.n || 3);
        else if (t.when === 'wear') hit = car.tyre.wear / life * 100 >= (t.n || 90);
        if (!hit) return;
        t.fired = true;
        if (r() * 100 >= (t.chance == null ? 100 : t.chance)) { log.push({ kind: 'trigger', ids: [car.id], text: car.driver.code + ': ' + TRIGGER_WHY[t.when] + ', but the team sticks with the plan' }); return; }
        if (t.action === 'plan' && car.plans[t.plan]) switchPlan(car, car.plans[t.plan], s, log, TRIGGER_WHY[t.when]);
        else if (t.action === 'mode' && MODES[t.mode]) { car.mode = t.mode; car.modeHold = 6; log.push({ kind: 'trigger', ids: [car.id], text: car.driver.code + ': ' + TRIGGER_WHY[t.when] + ', so the call is ' + MODES[t.mode].label.toLowerCase() }); }
        else if (t.action === 'box') { car.pendingBox = 'auto'; log.push({ kind: 'trigger', ids: [car.id], text: car.driver.code + ': ' + TRIGGER_WHY[t.when] + ', so the team calls them in' }); }
      });
    });
  }
  /* The race approach picks the driving mode each lap, unless the pit wall has just made a call. */
  function applyApproach(s, field) {
    field.forEach(function (car, i) {
      if (!car.approach || car.approach === 'balanced') return;
      if (car.modeHold > 0) { car.modeHold -= 1; return; }
      var ahead = field[i - 1], behind = field[i + 1], ga = ahead ? car.cum - ahead.cum : 99, gb = behind ? behind.cum - car.cum : 99;
      var worn = car.tyre.wear > tyreLife(car.tyre.compound, car, s.circuit) * 0.8;
      if (car.approach === 'attacker') car.mode = ga < 1.2 && !worn ? 'push' : 'standard';
      else if (car.approach === 'defender') car.mode = gb < 1.0 && !worn ? 'push' : 'standard';
      else if (car.approach === 'tyres') car.mode = ga > 1.5 && gb > 1.5 ? 'manage' : 'standard';
    });
  }

  /* ------------------------------------------------------------ driver moments
     The same numbers are shown to the player and used to settle the moment. */
  function momentOdds(kind, choice, me, other, circuit) {
    var ease = circuit && circuit.overtaking != null ? circuit.overtaking : 0.7, d = me.driver, o = other ? other.driver : null;
    if (kind === 'attack') {
      var base = 0.3 + (attack(d) - (o ? defend(o) : 80)) * 0.012 + (ease - 0.7) * 0.35;
      var b = { outside: [0.14, 0.3], inside: [0.06, 0.12], boost: [0.1, 0.05], wait: [-1, 0] }[choice] || [0, 0];
      if (choice === 'boost' && me.energy < 35) b = [0.0, 0.05];
      return { success: choice === 'wait' ? 0 : clamp(base + b[0], 0.05, 0.9), contact: b[1] };
    }
    if (kind === 'defend') {
      var keep = 0.5 + (defend(d) - (o ? attack(o) : 80)) * 0.012 - (ease - 0.7) * 0.25;
      return { success: choice === 'concede' ? 0 : clamp(keep + (choice === 'cover' ? 0.2 : 0), 0.05, 0.95), contact: choice === 'cover' ? 0.08 : 0 };
    }
    var jump = clamp(0.5 + (attack(d) - 80) * 0.01, 0.2, 0.85);
    return { success: choice === 'jump' ? jump : 0, contact: choice === 'jump' ? 0.12 : 0 };
  }
  function settleMoments(s, r, log) {
    var R = s.rules, ordered = order(s);
    running(s).filter(function (c) { return c.moment; }).forEach(function (car) {
      var m = car.moment, idx = ordered.indexOf(car), ahead = ordered[idx - 1], behind = ordered[idx + 1], code = car.driver.code;
      if (m.kind === 'attack') {
        var odds = momentOdds('attack', m.choice, car, ahead, s.circuit);
        if (m.choice === 'wait' || !ahead) { car.tyre.wear = Math.max(0, car.tyre.wear - 0.3); car.energy = clamp(car.energy + 15, 0, 100);
          log.push({ kind: 'moment', ids: [car.id], text: code + ' bides their time, saving tyres and battery' }); return; }
        if (m.choice === 'boost') car.energy = Math.max(0, car.energy - 35);
        if (r() < odds.success) {
          if (car.cum > ahead.cum) { var t = ahead.cum; car.cum = round3(t - 0.15); ahead.cum = round3(Math.max(ahead.cum, car.cum + R.minGap * 0.5)); }
          log.push({ kind: 'moment', ids: [car.id, ahead.id], text: code + (m.choice === 'outside' ? ' goes around the outside of ' : m.choice === 'inside' ? ' dives down the inside of ' : ' uses the boost to pass ') + ahead.driver.code + ' and makes it stick' });
        } else if (r() < odds.contact / Math.max(0.05, 1 - odds.success)) {
          car.cum = round3(car.cum + 2.5); log.push({ kind: 'moment', ids: [car.id, ahead.id], text: code + ' makes contact with ' + ahead.driver.code + ' and loses time' });
          if (r() < 0.12) retire(car, 'Accident', log, s);
        } else { if (car.cum < ahead.cum) car.cum = round3(ahead.cum + R.minGap + 0.1); log.push({ kind: 'moment', ids: [car.id, ahead.id], text: code + ' tries a move on ' + ahead.driver.code + ' but it doesn’t work' }); }
      } else if (m.kind === 'defend') {
        if (!behind) return;
        if (m.choice === 'concede') { if (behind.cum > car.cum) { var u = car.cum; car.cum = round3(behind.cum + 0.4); behind.cum = round3(Math.min(behind.cum, u)); }
          car.tyre.wear = Math.max(0, car.tyre.wear - 0.3); log.push({ kind: 'moment', ids: [car.id, behind.id], text: code + ' lets ' + behind.driver.code + ' through to save the tyres' }); return; }
        var od = momentOdds('defend', m.choice, car, behind, s.circuit);
        if (m.choice === 'cover') car.cum = round3(car.cum + 0.2);
        if (r() < od.success) { if (behind.cum < car.cum) { var v = car.cum; car.cum = round3(behind.cum - 0.1); behind.cum = round3(Math.max(v, car.cum + R.minGap)); }
          log.push({ kind: 'moment', ids: [car.id, behind.id], text: code + ' holds off ' + behind.driver.code }); }
        else if (r() < od.contact / Math.max(0.05, 1 - od.success)) { car.cum = round3(car.cum + 2); log.push({ kind: 'moment', ids: [car.id, behind.id], text: code + ' and ' + behind.driver.code + ' touch as ' + code + ' moves to defend' }); }
        else { if (behind.cum > car.cum) { var x = car.cum; car.cum = round3(behind.cum + 0.3); behind.cum = round3(x); } log.push({ kind: 'moment', ids: [car.id, behind.id], text: behind.driver.code + ' gets past ' + code }); }
      } else if (m.kind === 'restart' && m.choice === 'jump') {
        var oj = momentOdds('restart', 'jump', car, ahead, s.circuit);
        if (r() < oj.success) { car.cum = round3(car.cum - 0.6); log.push({ kind: 'moment', ids: [car.id], text: code + ' gets a great jump at the restart' }); }
        else if (r() < oj.contact / Math.max(0.05, 1 - oj.success)) { car.cum = round3(car.cum + 1.5); log.push({ kind: 'moment', ids: [car.id], text: code + ' gets the restart wrong and loses time' }); }
      }
    });
    s.cars.forEach(function (c) { delete c.moment; });
  }

  /* ------------------------------------------------------------ qualifying */
  function qualify(opts) {
    var rules = merge(DEFAULTS, opts.rules), circuit = opts.circuit, entries = opts.entries, r = rng(mix(opts.seed, 0, 1));
    var track = TRACK.indexOf((opts.weather && opts.weather.qualifying) || (opts.weather && opts.weather.start) || 'dry');
    if (track < 0) track = 0;
    var comp = track === 2 ? 'wet' : track === 1 ? 'inter' : 'soft', log = [], res = {};
    entries = entries.map(function (e) { return merge(e, { form: weekendForm(opts.seed, e.id, rules) }); });
    entries.forEach(function (e) { res[e.id] = { id: e.id, times: [null, null, null], out: null }; });
    function run(e) {
      var best = Infinity;
      for (var i = 0; i < 2; i++) {
        var t = basePace(e, circuit, rules, track) - rules.fuelEffect - 0.35 + GRIP[comp][track] + (e.qualiAdj || 0)
          + gauss(r) * (0.08 + (100 - e.driver.consistency) * 0.006);
        if (r() < 0.04 * (1 + track) * composure(e.driver)) { log.push({ kind: 'mistake', ids: [e.id], text: e.driver.code + ' runs wide and abandons a lap' }); continue; }
        best = Math.min(best, t);
      }
      return best;
    }
    var field = entries.slice(), sizes = [entries.length, Math.min(entries.length, rules.qualifying.q2), Math.min(entries.length, rules.qualifying.q3)];
    var order = [];
    for (var q = 0; q < 3; q++) {
      field.forEach(function (e) { res[e.id].times[q] = round3(run(e)); });
      field.sort(function (a, b) { return res[a.id].times[q] - res[b.id].times[q]; });
      var cut = q < 2 ? sizes[q + 1] : field.length;
      var out = field.slice(cut);
      out.forEach(function (e) { res[e.id].out = 'Q' + (q + 1); });
      order = out.concat(order);
      field = field.slice(0, cut);
      if (q < 2 && out.length) log.push({ kind: 'session', text: 'Q' + (q + 1) + ' eliminated: ' + out.map(function (e) { return e.driver.code; }).join(', ') });
    }
    order = field.concat(order);
    log.push({ kind: 'pole', ids: [order[0].id], text: order[0].driver.code + ' takes pole' });
    return { grid: order.map(function (e) { return e.id; }), results: order.map(function (e, i) { var x = res[e.id]; x.position = i + 1; return x; }), log: log };
  }

  /* ------------------------------------------------------------ race set-up */
  function startCompound(pos, n, track) {
    if (track === 2) return 'wet';
    if (track === 1) return 'inter';
    return pos <= Math.ceil(n * 0.45) ? (pos % 3 === 0 ? 'medium' : 'soft') : (pos % 2 ? 'medium' : 'hard');
  }
  function createRace(opts) {
    var rules = merge(DEFAULTS, opts.rules), circuit = opts.circuit, laps = circuit.laps;
    if (opts.sprint) {   /* about 100 km, sprint points, no compulsory second compound */
      laps = circuit.sprintLaps || Math.ceil(circuit.laps / 3);
      rules = merge(rules, { points: (opts.rules && opts.rules.sprintPoints) || [8, 7, 6, 5, 4, 3, 2, 1], mandatoryCompounds: false });
    }
    var byId = {}; opts.entries.forEach(function (e) { byId[e.id] = e; });
    var grid = opts.grid || opts.entries.map(function (e) { return e.id; });
    var plan = weatherPlan(opts.weather, laps, opts.seed);
    var cars = grid.map(function (id, i) {
      var e = byId[id], comp = e.startTyre || startCompound(i + 1, grid.length, plan[0]);
      return {
        id: id, team: e.team, driver: e.driver, car: e.car, setup: e.setup == null ? 60 : e.setup,
        grid: i + 1, status: 'running', dnf: null, cum: i * 0.25, lastLap: null, bestLap: null,
        tyre: { compound: comp, wear: 0, age: 0 }, stints: [{ compound: comp, from: 1, to: null }],
        paceAdj: e.paceAdj || 0, form: weekendForm(opts.seed, id, rules), ai: e.ai || {},
        plans: (e.plans || []).slice(), triggers: (e.triggers || []).map(function (t) { return merge(t, { fired: false }); }), approach: e.approach || null, modeHold: 0,
        used: [comp], stops: 0, mode: MODES[e.startMode] ? e.startMode : 'standard', energy: 60, plan: (e.plan || []).slice().sort(function (a, b) { return a.lap - b.lap; }), planned: !!e.planned, manual: !!e.manual,
        pendingBox: null, refuse: false, positions: [], lapTimes: []
      };
    });
    return {
      version: 1, seed: opts.seed >>> 0, circuit: circuit, rules: rules, sprint: !!opts.sprint, lap: 0, laps: laps, track: plan,
      sc: { type: null, laps: 0 }, cars: cars, orders: {}, fastest: null, finished: false, events: []
    };
  }

  /* ------------------------------------------------------------ calls */
  function applyCalls(s, calls, log) {
    (calls || []).forEach(function (c) {
      if (c.team) { s.orders[c.team] = c.value === 'none' ? null : { value: c.value, lap: s.lap + 1 };
        if (c.value !== 'none') log.push({ kind: 'order', team: c.team, text: 'Team order for ' + c.team + ': ' + c.value }); return; }
      var car = s.cars.filter(function (x) { return x.id === c.entry; })[0];
      if (!car || car.status !== 'running') return;
      if (c.type === 'box') car.pendingBox = c.compound || 'auto';
      else if (c.type === 'mode' && MODES[c.value]) { car.mode = c.value; car.modeHold = 3; }
      else if (c.type === 'plan') { car.plan = (c.stops || []).filter(function (p) { return p.lap > s.lap; }).sort(function (a, b) { return a.lap - b.lap; }); car.planned = true; }
      else if (c.type === 'strategy') {
        if (c.plan != null && car.plans[c.plan]) { switchPlan(car, car.plans[c.plan], s, log, 'a call from the pit wall'); return; }
        car.plan = (c.stops || []).filter(function (p) { return p.lap > s.lap; }).sort(function (a, b) { return a.lap - b.lap; });
        car.planned = true; car.planName = c.name || null;
        car.ai = merge(car.ai || {}, { wetCall: c.wetCall || 'normal', dryCall: c.dryCall || 'normal', useSC: c.useSC !== false });
        log.push({ kind: 'order', ids: [car.id], text: car.driver.code + ' switches to ' + (c.name || 'a new plan') });
      }
      else if (c.type === 'manual') car.manual = !!c.value;
      else if (c.type === 'moment') car.moment = { kind: c.kind, choice: c.choice };
      else if (c.type === 'refuseOrder') { car.refuse = true; log.push({ kind: 'order', ids: [car.id], text: car.driver.code + ' refuses the team order' }); }
    });
  }

  /* ------------------------------------------------------------ AI strategist */
  function chooseCompound(car, s, track) {
    if (track === 2) return 'wet';
    if (track === 1) return 'inter';
    var left = s.laps - s.lap, opts = ['soft', 'medium', 'hard'];
    var dryUsed = car.used.filter(function (c) { return !COMPOUNDS[c].wet; });
    var needNew = s.rules.mandatoryCompounds !== false && dryUsed.length === 1 ? dryUsed[0] : null;
    for (var i = 0; i < opts.length; i++) {
      var c = opts[i];
      if (tyreLife(c, car, s.circuit) * 1.05 >= left && c !== needNew) return c;
    }
    return needNew === 'hard' ? 'medium' : 'hard';
  }
  /* How many laps in a row, up to this one, the track has been wet (or dry). */
  function streak(s, wet) { var n = 0; for (var i = s.lap - 1; i >= 0; i--) { if ((s.track[i] > 0) === wet) n++; else break; } return n; }
  function aiWantsBox(car, s, track) {
    var left = s.laps - s.lap, c = COMPOUNDS[car.tyre.compound], life = tyreLife(car.tyre.compound, car, s.circuit), ai = car.ai || {};
    /* Weather first: the team's call decides how soon to react. Late means staying on slicks through the damp. */
    if (track > 0 && !c.wet) { var w = streak(s, true), wc = ai.wetCall || 'normal';
      if (wc === 'early' ? w >= 1 : wc === 'late' ? (track === 2 || w >= 4) : w >= 2) return 'auto'; return car.planned ? null : null; }
    if (track === 0 && c.wet) { var d = streak(s, false), dc = ai.dryCall || 'normal';
      if (dc === 'early' ? d >= 1 : dc === 'late' ? d >= 4 : d >= 2) return 'auto'; return null; }
    if (track === 1 && car.tyre.compound === 'wet' && s.track[s.lap - 2] === 1) return 'auto';
    if (track === 2 && car.tyre.compound === 'inter' && s.track[s.lap - 2] === 2) return 'auto';
    if (c.wet) return null;
    var dry = car.used.filter(function (x) { return !COMPOUNDS[x].wet; });
    var wetRace = s.track.some(function (t) { return t > 0; });
    var mustSecond = s.rules.mandatoryCompounds !== false && !wetRace && dry.length < 2 && left <= 3 && left > 1;
    if (car.planned) {
      /* The team's plan: stop on the planned lap, early under a safety car if it says so, or if the tyre is finished. */
      var next = car.plan[0];
      if (next && next.lap <= s.lap && left > 1) return next.compound || 'auto';
      if (next && s.sc.type && ai.useSC !== false && next.lap - s.lap <= 10 && left > 3) return next.compound || 'auto';
      if (car.tyre.wear > life * 1.15 && left > 2) return (next && next.compound) || 'auto';
      return mustSecond ? 'auto' : null;
    }
    if (car.manual) return car.tyre.wear > life * 1.3 ? 'auto' : null;
    if (left <= 1) return null;
    var stretch = ai.stretch || 1;
    if (car.tyre.wear >= life * 0.92 * stretch && left > 3) return 'auto';
    if (s.sc.type && car.tyre.wear > life * (ai.scPit || 0.45) && left > 8) return 'auto';
    if (ai.undercut && !s.sc.type && car.tyre.wear >= life * 0.7 && left > 8) {
      /* Undercut: stop early when stuck within a second and a half of the car ahead. */
      var ahead = order(s).filter(function (x) { return x.cum < car.cum; }).pop();
      if (ahead && car.cum - ahead.cum < 1.5 && ahead.tyre.age >= car.tyre.age - 2) return 'auto';
    }
    return mustSecond ? 'auto' : null;
  }

  /* ------------------------------------------------------------ one lap */
  function running(s) { return s.cars.filter(function (c) { return c.status === 'running'; }); }
  function order(s) { return running(s).sort(function (a, b) { return a.cum - b.cum; }); }

  function stepLap(state, calls) {
    var s = JSON.parse(JSON.stringify(state)), log = [];
    if (s.finished) return { state: s, log: log };
    applyCalls(s, calls, log);
    s.lap += 1;
    var R = s.rules, circuit = s.circuit, r = rng(mix(s.seed, s.lap, 2)), track = s.track[s.lap - 1];
    if (s.lap > 1 && track !== s.track[s.lap - 2]) log.push({ kind: 'weather', text: 'Track now ' + TRACK[track] });
    var field = order(s), leader0 = field[0] ? field[0].cum : 0;
    var newSc = null, ctx = {};
    /* The start, and restarts after a safety car: tangles and (rarely) pile-ups. */
    if (!s.sc.type && (s.lap === 1 || s.restartLap === s.lap)) startIncidents(s, R, r, track, field, log, ctx, s.lap !== 1);

    if (!s.sc.type) applyApproach(s, field);
    /* An all-electric race: everyone eases off when the battery runs low, unless the pit wall has just made a call. */
    if (R.modeEnergy && (R.modeEnergy.standard || 0) < 0 && !s.sc.type) field.forEach(function (car) {
      if (car.modeHold > 0) return;
      if (car.energy < 12) car.mode = 'manage'; else if (car.mode === 'manage' && car.energy > 50 && car.approach !== 'tyres') car.mode = 'standard';
    });
    /* raw lap times */
    var raw = {};
    field.forEach(function (car, i) {
      if (car.status !== 'running') return;
      var m = MODES[car.mode], t = basePace(car, circuit, R, track) + m.pace + tyreTime(car.tyre, car, circuit, track)
        + R.fuelEffect * (1 - (s.lap - 1) / s.laps);
      if (R.emptyBattery && !R.noHybrid && car.energy <= 0) t += R.emptyBattery;
      t += gauss(r) * (0.12 + (100 - car.driver.consistency) * 0.008);
      if (s.lap === 1) t += 4 + gauss(r) * (0.5 + (100 - car.driver.racecraft) * 0.02);
      var risk = m.risk * (1 + track * 1.5) * (1 + ((car.driver.aggression || 50) - 50) / 100) * composure(car.driver) * (s.lap === 1 ? 4 : 1);
      var lost = carIncidents(car, s, R, r, track, risk, log, ctx);
      if (lost === null) return;
      t += lost;
      if (i > 0 && !s.sc.type) {
        var gap = car.cum - field[i - 1].cum;
        if (gap < 1.0) t += R.dirtyAir * (1 - gap);
      }
      raw[car.id] = t;
    });
    trackIncidents(s, R, r, track, log, ctx);

    field = field.filter(function (c) { return c.status === 'running'; });
    var start = {}; field.forEach(function (c) { start[c.id] = c.cum; });

    if (s.sc.type) {
      /* Behind the safety car: no passing; under the full SC the field bunches up. */
      var scLap = circuit.baseLap * (s.sc.type === 'sc' ? R.scPace : R.vscPace), prevEnd = null;
      field.forEach(function (car) {
        var end;
        if (s.sc.type === 'sc') {
          /* The leader follows the safety car; everyone else closes up to the train, but no faster than racing pace. */
          end = prevEnd == null ? car.cum + scLap : Math.max(prevEnd + R.scBunch, car.cum + circuit.baseLap * 1.08);
        } else end = car.cum + scLap + (raw[car.id] - circuit.baseLap) * 0.2;
        car.lastLap = round3(end - car.cum); car.cum = round3(end); prevEnd = end;
      });
    } else {
      /* Green flag: resolve each car against the one ahead, front to back. */
      field.forEach(function (car, i) {
        var t = raw[car.id], end = car.cum + t;
        if (i > 0) {
          var ahead = field[i - 1], aheadEnd = ahead.cum, sameTeam = ahead.team === car.team;
          var ord = s.orders[car.team];
          if (end < aheadEnd + R.minGap) {
            var hold = sameTeam && ord && ord.value === 'hold' && !car.refuse;
            /* Racing close: sometimes they touch. */
            if (!hold && ahead.status === 'running') {
              var cc = 0.003 * (R.incidents ? R.incidents.crashes : 1) * (1 + track) * (1 + ((car.driver.aggression || 50) - 50) / 80) * (s.lap === 1 || s.restartLap === s.lap ? 2.5 : 1);
              if (r() < cc) {
                var before = car.cum; contactIncident(car, ahead, s, R, r, log, ctx); end += car.cum - before; car.cum = before;
                if (car.status !== 'running' || ahead.status !== 'running') { car.lastLap = round3(end - car.cum); car.cum = round3(end); return; }
              }
            }
            var chance = 0;
            if (!hold) {
              var adv = raw[ahead.id] - t, ease = circuit.overtaking == null ? 0.7 : circuit.overtaking;
              chance = ease * (R.overtake.base + Math.max(0, adv - 0.1) * R.overtake.pace) + (attack(car.driver) - defend(ahead.driver)) * R.overtake.racecraft;
              if (!R.noHybrid && car.energy >= R.overtakeMode.cost && (start[car.id] - start[ahead.id]) < R.overtakeMode.gap) { chance += R.overtakeMode.bonus * (0.4 + ease * 0.6); car.energy -= R.overtakeMode.cost; }
              if (track > 0) chance += (car.driver.wet - ahead.driver.wet) * 0.005;
              chance = clamp(chance, 0.005, 0.85);
            }
            if (!hold && r() < chance) {
              end = Math.min(end, aheadEnd - 0.1 - r() * 0.3);
              var pushed = Math.max(ahead.cum, end + R.minGap * 0.5);
              ahead.lastLap = round3(ahead.lastLap + pushed - ahead.cum); ahead.cum = round3(pushed);
              log.push({ kind: 'overtake', ids: [car.id, ahead.id], text: car.driver.code + ' passes ' + ahead.driver.code + ' for P' + i });
              field[i - 1] = car; field[i] = ahead;
            } else {
              end = aheadEnd + R.minGap + r() * 0.3;
            }
          }
        }
        car.lastLap = round3(end - car.cum); car.cum = round3(end);
      });
      field = field.filter(function (c) { return c.status === 'running'; });
      /* Team order: swap */
      Object.keys(s.orders).forEach(function (team) {
        var o = s.orders[team]; if (!o || o.value !== 'swap') return;
        var mates = order(s).filter(function (c) { return c.team === team; });
        if (mates.length < 2) return;
        var front = mates[0], back = mates[1];
        if (back.cum - front.cum > 2.5) return;
        if (front.refuse) { log.push({ kind: 'order', ids: [front.id], text: front.driver.code + ' ignores the call to let ' + back.driver.code + ' by' }); s.orders[team] = null; return; }
        var t = front.cum; front.cum = round3(back.cum + 0.6); back.cum = round3(Math.min(back.cum, t + 0.2));
        log.push({ kind: 'order', ids: [front.id, back.id], text: front.driver.code + ' lets ' + back.driver.code + ' through on team orders' });
        s.orders[team] = null;
      });
    }

    settleMoments(s, r, log);

    /* tyres, energy, pit stops (laps after a pit stop don't count for fastest lap) */
    var box0 = {}; running(s).forEach(function (car) { box0[car.id] = s.events.concat(log).some(function (e) { return e.kind === 'pit' && e.ids[0] === car.id && (e.lap === s.lap - 1 || e.lap == null); }); });
    running(s).forEach(function (car) {
      var m = MODES[car.mode];
      car.tyre.age += 1;
      car.tyre.wear = round3(car.tyre.wear + (s.sc.type ? 0.3 : 1) * m.deg * (circuit.tyreStress || 1) * (1.25 - car.driver.tyreMgmt / 200));
      car.energy = R.noHybrid ? 0 : clamp(car.energy + (R.modeEnergy && R.modeEnergy[car.mode] != null ? R.modeEnergy[car.mode] : m.energy), 0, 100);
      if (!s.sc.type && !box0[car.id] && car.lastLap && (!car.bestLap || car.lastLap < car.bestLap)) car.bestLap = car.lastLap;
      if (!s.sc.type && !box0[car.id] && car.lastLap && (!s.fastest || car.lastLap < s.fastest.time)) s.fastest = { id: car.id, time: car.lastLap, lap: s.lap };
      var box = car.pendingBox || (s.lap < s.laps ? aiWantsBox(car, s, track) : null);
      if (box && s.lap < s.laps) {
        var nextTrack = s.track[s.lap] != null ? s.track[s.lap] : track;
        var comp = box === 'auto' || !COMPOUNDS[box] ? chooseCompound(car, s, nextTrack) : box;
        /* Back onto slicks after rain: that stop is the next planned one, on its tyre. */
        var offWets = COMPOUNDS[car.tyre.compound].wet && !COMPOUNDS[comp].wet;
        if (offWets && car.planned && car.plan.length && nextTrack === 0 && (box === 'auto' || !COMPOUNDS[box])) comp = car.plan[0].compound || comp;
        var crew = car.car.pitSpeed == null ? 85 : car.car.pitSpeed;
        var stop = Math.max(1.9, R.pitStop.mean - (crew - 85) * 0.03 + gauss(r) * R.pitStop.sd);
        var slow = r() < R.pitStop.slowChance * (1 + (85 - crew) / 30); if (slow) stop += 2 + r() * 6;
        var pm = (R.incidents || { failures: 1 }).failures, note = '';
        if (car.repair) { stop += car.repair; note += ', a new nose'; }
        if (car.limp && car.limp.fix) car.limp = null;
        car.repair = 0; car.flatSpot = false;
        if (car.pen) { stop += car.pen; note += ', serving a ' + car.pen + '-second penalty'; car.penServed = (car.penServed || 0) + car.pen; car.pen = 0; }
        if (r() < INC.wheelnut.perStop * pm) { var wn = rr(r, 5, 12); stop += wn; log.push({ kind: 'incident', inc: 'wheelnut', ids: [car.id], text: car.driver.code + ' loses ' + wn.toFixed(0) + 's with a wheel nut problem' }); }
        else if (r() < INC.stall.perStop * pm) { var stl = rr(r, 6, 10); stop += stl; log.push({ kind: 'incident', inc: 'stall', ids: [car.id], text: car.driver.code + ' stalls in the pit box, ' + stl.toFixed(0) + 's lost' }); }
        var unsafe = r() < INC.unsafe.perStop * pm, speeding = r() < INC.speeding.perStop * pm;
        var loss = (circuit.pitLoss || 21) * (s.sc.type === 'sc' ? 0.55 : s.sc.type === 'vsc' ? 0.65 : 1) + stop;
        car.cum = round3(car.cum + loss); car.lastLap = round3(car.lastLap + loss);
        car.stints[car.stints.length - 1].to = s.lap;
        car.stints.push({ compound: comp, from: s.lap + 1, to: null });
        car.tyre = { compound: comp, wear: 0, age: 0 }; car.stops += 1; car.pendingBox = null;
        if (car.used.indexOf(comp) < 0) car.used.push(comp);
        /* A dry stop uses up the next planned stop (even if it came early); weather stops don't. Stops planned for the next few laps are dropped. */
        var weatherStop = COMPOUNDS[comp].wet;
        if (!weatherStop && car.plan.length) car.plan.shift();
        car.plan = car.plan.filter(function (p) { return p.lap > s.lap + 3; });
        log.push({ kind: 'pit', ids: [car.id], text: car.driver.code + ' pits for ' + COMPOUNDS[comp].label + 's (' + stop.toFixed(1) + 's' + (slow ? ', slow stop' : '') + note + ')' });
        if (unsafe) { penalise(car, 5, { inc: 'unsafe', text: 'unsafe release' }, log); if (r() < 0.2) { retire(car, 'Lost a wheel after an unsafe release', log, s, 'unsafe'); flagUp(ctx, 'vsc'); } }
        if (speeding && car.status === 'running') penalise(car, 5, { inc: 'speeding', text: 'speeding in the pit lane' }, log);
      }
    });

    /* safety car bookkeeping */
    if (ctx.flag === 'sc' || ctx.flag === 'vsc') newSc = newSc === 'sc' ? 'sc' : ctx.flag;
    if (s.sc.type) {
      s.sc.laps -= 1;
      if (s.sc.laps <= 0) { log.push({ kind: s.sc.type, text: (s.sc.type === 'sc' ? 'Safety car' : 'Virtual safety car') + ' ends, racing resumes' }); if (s.sc.type === 'sc') s.restartLap = s.lap + 1; s.sc = { type: null, laps: 0 }; }
    } else if (newSc && s.lap < s.laps - 1) {
      s.sc = { type: newSc, laps: newSc === 'sc' ? 3 + Math.floor(r() * 3) : 2 + Math.floor(r() * 2) };
      log.push({ kind: newSc, text: newSc === 'sc' ? 'Safety car deployed' : 'Virtual safety car deployed' });
    }

    /* A red flag: the race stops. Gaps close up, everyone gets fresh tyres and repairs, then a restart behind the safety car. */
    if (ctx.endRace && s.lap < s.laps) { log.push({ kind: 'red', inc: 'storm', text: 'Red flag: the race is not resumed, and the results stand' }); s.laps = s.lap; }
    else if (ctx.flag === 'red' && s.lap < s.laps - 1) {
      var stopped = order(s), lead0 = stopped[0], nt = s.track[s.lap] != null ? s.track[s.lap] : track;
      log.push({ kind: 'red', inc: 'red', text: 'Red flag: the race is stopped' }); s.redFlags = (s.redFlags || 0) + 1;
      stopped.forEach(function (c, i) {
        c.cum = round3((lead0 ? lead0.cum : 0) + i * 0.8);
        var comp = chooseCompound(c, s, nt);
        if (comp !== c.tyre.compound) { c.stints[c.stints.length - 1].to = s.lap; c.stints.push({ compound: comp, from: s.lap + 1, to: null }); if (c.used.indexOf(comp) < 0) c.used.push(comp); }
        c.tyre = { compound: comp, wear: 0, age: 0 }; if (c.limp && c.limp.fix) c.limp = null; c.repair = 0; c.flatSpot = false; c.pendingBox = null;
      });
      s.sc = { type: 'sc', laps: 2 }; log.push({ kind: 'sc', text: 'The race will restart behind the safety car, with fresh tyres and repairs for everyone' });
    }
    if (s.slippery > 0) s.slippery -= 1;
    order(s).forEach(function (car, i) { car.positions.push(i + 1); car.lapTimes.push(car.lastLap); car.refuse = car.refuse && !!s.orders[car.team]; });
    if (!s.finished || s.lap < s.laps) checkTriggers(s, r, log, track, log.some(function (l) { return (l.kind === 'sc' || l.kind === 'vsc') && /deployed/.test(l.text); }));
    s.cars.forEach(function (car) { if (car.status !== 'running' && car.positions.length < s.lap) car.positions.push(null); });

    if (s.lap >= s.laps) {
      s.finished = true;
      running(s).forEach(function (c) { c.stints[c.stints.length - 1].to = s.lap;
        if (c.pen) { c.cum = round3(c.cum + c.pen); c.penServed = (c.penServed || 0) + c.pen; log.push({ kind: 'penalty', inc: 'served', ids: [c.id], text: c.driver.code + '’s ' + c.pen + '-second penalty is added to their race time' }); c.pen = 0; } });
      var w = order(s)[0];
      log.push({ kind: 'finish', ids: w ? [w.id] : [], text: w ? w.driver.code + ' wins the ' + (circuit.race || circuit.name) : 'Race over' });
    }
    log.forEach(function (l) { l.lap = s.lap; });
    s.events = s.events.concat(log);
    return { state: s, log: log };
  }

  /* ------------------------------------------------------------ race incidents
     The catalogue: each incident's family, what it does, and how often it happens on a normal
     setting (perRace: about how many in a dry 55-lap race with 22 cars; perStop: chance at each pit
     stop; perStart: chance at the start). Race Control's settings scale each family:
     crashes (driver errors, contact, pile-ups, tyres and stewards), failures (mechanical and pit lane)
     and outside events. Rain, lap 1, restarts, push mode, aggression, reliability, tyre wear, street
     circuits and the engine era move the odds for each car. */
  var INCIDENTS = [
    { id: 'lockup', family: 'driver', label: 'Lock-up, runs wide', perRace: 4.0, effect: '1 to 2.5s lost; sometimes a flat-spotted tyre (slower until the next stop)' },
    { id: 'off', family: 'driver', label: 'Off the track, rejoins', perRace: 2.0, effect: '3 to 7s lost' },
    { id: 'spin', family: 'driver', label: 'Spin', perRace: 0.7, effect: '8 to 16s lost' },
    { id: 'gravel', family: 'driver', label: 'Through the gravel', perRace: 0.35, effect: '15 to 30s lost; sometimes front wing damage' },
    { id: 'wing', family: 'driver', label: 'Clips the barrier: front wing damage', perRace: 0.3, effect: 'About 1.4s a lap slower until the car pits for a new nose' },
    { id: 'beached', family: 'driver', label: 'Beached in the gravel', perRace: 0.12, effect: 'Out; virtual safety car or safety car' },
    { id: 'wall', family: 'driver', label: 'Hits the barrier', perRace: 0.4, effect: 'Out; safety car (sometimes virtual), red flag 1 in 10' },
    { id: 'heavy', family: 'driver', label: 'Heavy crash', perRace: 0.07, effect: 'Out; red flag half the time, else safety car' },
    { id: 'contact', family: 'contact', label: 'Contact between two cars', perRace: 0.8, effect: 'A touch (time lost), a puncture, wing damage, one car out, or both out; stewards often penalise whoever caused it' },
    { id: 'tangle', family: 'pileup', label: 'First-lap or restart tangle (2 to 5 cars)', perStart: 0.2, effect: 'Each car: out, damaged, punctured or delayed; safety car or red flag' },
    { id: 'pileup', family: 'pileup', label: 'Multi-car pile-up (5 to 8 cars)', perStart: 0.02, effect: 'Red flag; several cars out' },
    { id: 'pu', family: 'mechanical', label: 'Power unit failure', perRace: 0.28, effect: 'Out; sometimes smoke and a virtual safety car, sometimes oil on the track' },
    { id: 'gearbox', family: 'mechanical', label: 'Gearbox failure', perRace: 0.14, effect: 'Out' },
    { id: 'hydraulics', family: 'mechanical', label: 'Hydraulics failure', perRace: 0.10, effect: 'Out' },
    { id: 'energy', family: 'mechanical', label: 'Energy store failure (hybrid eras)', perRace: 0.07, effect: 'Out' },
    { id: 'fuel', family: 'mechanical', label: 'Fuel pressure problem', perRace: 0.05, effect: 'Out' },
    { id: 'electrical', family: 'mechanical', label: 'Electrical shutdown', perRace: 0.10, effect: 'A third restart after a power cycle (25s lost); the rest are out' },
    { id: 'brakes', family: 'mechanical', label: 'Brake failure', perRace: 0.05, effect: 'Out; half end in the barrier (safety car)' },
    { id: 'suspension', family: 'mechanical', label: 'Suspension failure', perRace: 0.05, effect: 'Out; some end in the barrier' },
    { id: 'fire', family: 'mechanical', label: 'Engine fire', perRace: 0.025, effect: 'Out; safety car' },
    { id: 'overheat', family: 'mechanical', label: 'Overheating (water leak)', perRace: 0.07, effect: 'A second a lap slower for 2 to 4 laps, then out' },
    { id: 'power', family: 'mechanical', label: 'Loss of power (MGU-K, or a misfire without hybrid)', perRace: 0.18, effect: 'About 0.6 to 0.9s a lap slower for the rest of the race' },
    { id: 'shift', family: 'mechanical', label: 'Gearshift problems', perRace: 0.12, effect: '0.6s a lap slower for 5 to 10 laps' },
    { id: 'braketemp', family: 'mechanical', label: 'Brake temperatures', perRace: 0.10, effect: '0.35s a lap slower for the rest of the race' },
    { id: 'floor', family: 'mechanical', label: 'Floor damage from the kerbs', perRace: 0.08, effect: '0.5s a lap slower for the rest of the race' },
    { id: 'puncture', family: 'tyre', label: 'Puncture', perRace: 0.22, effect: 'A slow lap back to the pits (12 to 20s) and a stop; more at street circuits and on worn tyres' },
    { id: 'blowout', family: 'tyre', label: 'Tyre failure on worn tyres', perRace: 0.05, effect: 'Only past 85% wear: a third crash out (safety car), the rest limp to the pits' },
    { id: 'wheelnut', family: 'pit', label: 'Wheel nut problem', perStop: 0.018, effect: '5 to 12s lost in the stop' },
    { id: 'unsafe', family: 'pit', label: 'Unsafe release', perStop: 0.006, effect: '5-second penalty; 1 in 5 lose a wheel and are out' },
    { id: 'speeding', family: 'pit', label: 'Speeding in the pit lane', perStop: 0.004, effect: '5-second penalty' },
    { id: 'stall', family: 'pit', label: 'Stalls in the pit box', perStop: 0.005, effect: '6 to 10s lost' },
    { id: 'tracklimits', family: 'stewards', label: 'Track limits', perRace: 0.35, effect: '5-second penalty' },
    { id: 'jumpstart', family: 'stewards', label: 'Jump start', perRace: 0.08, effect: '5-second penalty' },
    { id: 'debris', family: 'external', label: 'Debris on the track', perRace: 0.22, effect: 'Virtual safety car or safety car (more at circuits that have more)' },
    { id: 'bag', family: 'external', label: 'Debris in a brake duct or radiator', perRace: 0.10, effect: '0.4s a lap slower for 3 to 6 laps; sometimes out with overheating' },
    { id: 'animal', family: 'external', label: 'An animal on the track', perRace: 0.03, effect: 'Virtual safety car' },
    { id: 'invasion', family: 'external', label: 'A spectator on the track', perRace: 0.01, effect: 'Safety car' },
    { id: 'drain', family: 'external', label: 'Loose drain cover', perRace: 0.012, effect: 'Red flag while it is fixed' },
    { id: 'cloudburst', family: 'external', label: 'Sudden cloudburst', perRace: 0.05, effect: 'Wet track for 3 to 8 laps, then damp (not when the weekend is set to dry)' },
    { id: 'storm', family: 'external', label: 'Storm: lightning in the area', perRace: 0.008, effect: 'Red flag; in the last quarter of the race it is not resumed and the results stand' }
  ];
  var INC = {}; INCIDENTS.forEach(function (x) { INC[x.id] = x; });
  var REF_CAR_LAPS = 22 * 55, REF_LAPS = 55;
  function flagUp(ctx, kind) { var rank = { vsc: 1, sc: 2, red: 3 }; if (!ctx.flag || rank[kind] > rank[ctx.flag]) ctx.flag = kind; }
  function rr(r, a, b) { return a + r() * (b - a); }
  function penalise(car, secs, why, log) { car.pen = (car.pen || 0) + secs; log.push({ kind: 'penalty', inc: why.inc, ids: [car.id], text: car.driver.code + ' gets a ' + secs + '-second penalty: ' + why.text }); }
  function limp(car, o) { car.limp = o; }
  function needsPit(car, repair) { car.pendingBox = car.pendingBox || 'auto'; car.repair = Math.max(car.repair || 0, repair || 0); }
  var ANIMALS = ['A dog', 'A hare', 'A groundhog', 'A monitor lizard', 'A cat', 'A fox'];

  /* Incidents for one car on one lap. Returns time lost, or null if the car is out. */
  function carIncidents(car, s, R, r, track, risk, log, ctx) {
    var mult = R.incidents || { crashes: 1, failures: 1, outside: 1 }, add = 0, code = car.driver.code;
    /* What's already wrong with the car. */
    if (car.limp) {
      add += car.limp.pace;
      if (car.limp.laps != null) { car.limp.laps -= 1; if (car.limp.laps <= 0) { if (car.limp.out) { retire(car, car.limp.out, log, s, car.limp.inc); if (r() < 0.4) flagUp(ctx, 'vsc'); return null; } car.limp = null; } }
    }
    if (car.flatSpot) add += 0.2;
    if (s.sc.type) return add;
    var slip = s.slippery > 0 ? 2.5 : 1, cm = mult.crashes * slip, fm = mult.failures, om = mult.outside;
    var drv = function (id) { return INC[id].perRace / REF_CAR_LAPS * risk * cm; };
    /* Driver errors, most serious first; one per lap at most. */
    var roll = r(), acc = 0, pick = null, order = ['heavy', 'wall', 'beached', 'wing', 'gravel', 'spin', 'off', 'lockup'];
    for (var k = 0; k < order.length && !pick; k++) { acc += drv(order[k]) * (order[k] === 'lockup' || order[k] === 'off' ? 1 : (1 + track)); if (roll < acc) pick = order[k]; }
    if (pick === 'heavy') { retire(car, 'Heavy crash', log, s, 'heavy'); flagUp(ctx, r() < 0.5 ? 'red' : 'sc'); return null; }
    if (pick === 'wall') { retire(car, 'Hit the barrier', log, s, 'wall'); flagUp(ctx, r() < 0.1 ? 'red' : r() < 0.7 ? 'sc' : 'vsc'); return null; }
    if (pick === 'beached') { retire(car, 'Beached in the gravel', log, s, 'beached'); flagUp(ctx, r() < 0.7 ? 'vsc' : 'sc'); return null; }
    if (pick === 'wing') { limp(car, { pace: 1.4, laps: null, fix: true, inc: 'wing' }); needsPit(car, 9); log.push({ kind: 'damage', inc: 'wing', ids: [car.id], text: code + ' clips the barrier: front wing damage, pitting for a new nose' }); return add + rr(r, 2, 5); }
    if (pick === 'gravel') { var g = rr(r, 15, 30); log.push({ kind: 'mistake', inc: 'gravel', ids: [car.id], text: code + ' goes through the gravel, ' + g.toFixed(0) + 's lost' }); if (r() < 0.3) { limp(car, { pace: 1.4, laps: null, fix: true, inc: 'wing' }); needsPit(car, 9); log.push({ kind: 'damage', inc: 'wing', ids: [car.id], text: code + ' has front wing damage and pits for a new nose' }); } return add + g; }
    if (pick === 'spin') { var sp = rr(r, 8, 16); if (r() < 0.25) car.flatSpot = true; log.push({ kind: 'mistake', inc: 'spin', ids: [car.id], text: code + ' spins, ' + sp.toFixed(0) + 's lost' + (car.flatSpot ? ' and a flat-spotted tyre' : '') }); return add + sp; }
    if (pick === 'off') { var of = rr(r, 3, 7); log.push({ kind: 'mistake', inc: 'off', ids: [car.id], text: code + ' goes off and rejoins, ' + of.toFixed(1) + 's lost' }); return add + of; }
    if (pick === 'lockup') { var lu = rr(r, 1, 2.5); if (r() < 0.15) car.flatSpot = true; log.push({ kind: 'mistake', inc: 'lockup', ids: [car.id], text: code + ' locks up and runs wide, ' + lu.toFixed(1) + 's lost' + (car.flatSpot ? ', flat-spotting a tyre' : '') }); return add + lu; }
    /* Stewards. */
    if (r() < INC.tracklimits.perRace / REF_CAR_LAPS * mult.crashes * (1 + ((car.driver.aggression || 50) - 50) / 100)) penalise(car, 5, { inc: 'tracklimits', text: 'track limits' }, log);
    if (s.lap === 1 && r() < INC.jumpstart.perRace / 22 * mult.crashes) penalise(car, 5, { inc: 'jumpstart', text: 'jump start' }, log);
    /* Mechanical: worse with low reliability, a worn power unit and a fragile engine era. */
    var relF = Math.max(0.2, (1 - (car.car.reliability || 85) / 100) / 0.15) * (1 + (car.car.wear || 0) / 100) * fm;
    var mech = function (id) { return INC[id].perRace / REF_CAR_LAPS * relF; };
    var mroll = r(), macc = 0, mpick = null, mlist = ['pu', 'gearbox', 'hydraulics', 'energy', 'fuel', 'electrical', 'brakes', 'suspension', 'fire', 'overheat', 'power', 'shift', 'braketemp', 'floor'];
    for (var j = 0; j < mlist.length && !mpick; j++) { if (mlist[j] === 'energy' && R.noHybrid) continue; macc += mech(mlist[j]); if (mroll < macc) mpick = mlist[j]; }
    if (mpick && car.limp && ['overheat', 'power', 'shift', 'braketemp', 'floor'].indexOf(mpick) >= 0) mpick = null;
    if (mpick === 'pu') { retire(car, 'Power unit failure', log, s, 'pu'); if (r() < 0.25) flagUp(ctx, 'vsc'); if (r() < 0.15) { s.slippery = 3; log.push({ kind: 'incident', inc: 'oil', text: 'Oil on the track: it’s slippery for a few laps' }); } return null; }
    if (['gearbox', 'hydraulics', 'energy', 'fuel'].indexOf(mpick) >= 0) { retire(car, { gearbox: 'Gearbox failure', hydraulics: 'Hydraulics failure', energy: 'Energy store failure', fuel: 'Fuel pressure' }[mpick], log, s, mpick); if (r() < 0.2) flagUp(ctx, 'vsc'); return null; }
    if (mpick === 'electrical') { if (r() < 0.35) { log.push({ kind: 'damage', inc: 'electrical', ids: [car.id], text: code + ' stops with an electrical shutdown, power-cycles the car and gets going again, 25s lost' }); return add + 25; } retire(car, 'Electrical shutdown', log, s, 'electrical'); if (r() < 0.4) flagUp(ctx, 'vsc'); return null; }
    if (mpick === 'brakes' || mpick === 'suspension') { var wall = r() < (mpick === 'brakes' ? 0.5 : 0.4); retire(car, (mpick === 'brakes' ? 'Brake failure' : 'Suspension failure') + (wall ? ', into the barrier' : ''), log, s, mpick); if (wall) flagUp(ctx, 'sc'); return null; }
    if (mpick === 'fire') { retire(car, 'Engine fire', log, s, 'fire'); flagUp(ctx, 'sc'); return null; }
    if (mpick === 'overheat') { limp(car, { pace: 1.0, laps: 2 + Math.floor(r() * 3), out: 'Overheating', inc: 'overheat' }); log.push({ kind: 'damage', inc: 'overheat', ids: [car.id], text: code + ' is overheating: a water leak' }); return add + 1; }
    if (mpick === 'power') { var pw = rr(r, 0.6, 0.9); limp(car, { pace: pw, laps: null, inc: 'power' }); log.push({ kind: 'damage', inc: 'power', ids: [car.id], text: code + (R.noHybrid ? ' has an engine misfire' : ' loses electrical power (MGU-K)') + ', ' + pw.toFixed(1) + 's a lap slower' }); return add + pw; }
    if (mpick === 'shift') { limp(car, { pace: 0.6, laps: 5 + Math.floor(r() * 6), inc: 'shift' }); log.push({ kind: 'damage', inc: 'shift', ids: [car.id], text: code + ' has gearshift problems' }); return add + 0.6; }
    if (mpick === 'braketemp') { limp(car, { pace: 0.35, laps: null, inc: 'braketemp' }); log.push({ kind: 'damage', inc: 'braketemp', ids: [car.id], text: code + ' is managing brake temperatures' }); return add + 0.35; }
    if (mpick === 'floor') { limp(car, { pace: 0.5, laps: null, inc: 'floor' }); log.push({ kind: 'damage', inc: 'floor', ids: [car.id], text: code + ' has floor damage from the kerbs' }); return add + 0.5; }
    /* Tyres. */
    var street = (s.circuit.type || '') === 'street' ? 1.8 : 1, wearNow = car.tyre.wear || 0;
    if (r() < INC.puncture.perRace / REF_CAR_LAPS * street * (1 + wearNow / 100) * mult.crashes * slip) { var pc = rr(r, 12, 20); needsPit(car, 0); log.push({ kind: 'damage', inc: 'puncture', ids: [car.id], text: code + ' has a puncture: ' + pc.toFixed(0) + 's lost getting back to the pits' }); return add + pc; }
    if (wearNow > 85 && r() < 0.012 * (wearNow - 85) / 15 * mult.crashes) {
      if (r() < 0.35) { retire(car, 'Tyre failure, into the barrier', log, s, 'blowout'); flagUp(ctx, 'sc'); return null; }
      needsPit(car, 0); log.push({ kind: 'damage', inc: 'blowout', ids: [car.id], text: code + '’s worn tyre fails: limping back to the pits' }); return add + 25;
    }
    /* Debris picked up. */
    if (r() < INC.bag.perRace / REF_CAR_LAPS * om && !car.limp) { var bl = 3 + Math.floor(r() * 4); limp(car, { pace: 0.4, laps: bl, out: r() < 0.15 ? 'Overheating (debris in the radiator)' : null, inc: 'bag' }); log.push({ kind: 'damage', inc: 'bag', ids: [car.id], text: code + ' has debris caught in a brake duct' }); return add + 0.4; }
    return add;
  }
  /* Race-wide events on a lap. */
  function trackIncidents(s, R, r, track, log, ctx) {
    var om = (R.incidents || { outside: 1 }).outside, per = function (id) { return INC[id].perRace / REF_LAPS * om; };
    if (s.sc.type) return;
    if (r() < (s.circuit.scChance || 0.004) * om) { flagUp(ctx, r() < 0.6 ? 'vsc' : 'sc'); log.push({ kind: 'incident', inc: 'debris', text: 'Debris on the track' }); }
    if (r() < per('animal')) { flagUp(ctx, 'vsc'); log.push({ kind: 'incident', inc: 'animal', text: ANIMALS[Math.floor(r() * ANIMALS.length)] + ' on the track' }); }
    if (r() < per('invasion')) { flagUp(ctx, 'sc'); log.push({ kind: 'incident', inc: 'invasion', text: 'A spectator gets onto the track' }); }
    if (r() < per('drain')) { flagUp(ctx, 'red'); log.push({ kind: 'incident', inc: 'drain', text: 'A loose drain cover: red flag while it’s fixed' }); }
    if (R.weatherEvents !== false && track === 0 && s.lap < s.laps - 3 && r() < per('cloudburst')) {
      var n = 3 + Math.floor(r() * 6); for (var i = s.lap; i < Math.min(s.laps, s.lap + n); i++) s.track[i] = 2;
      for (var d = s.lap + n; d < Math.min(s.laps, s.lap + n + 2); d++) if (s.track[d] === 0) s.track[d] = 1;
      log.push({ kind: 'weather', inc: 'cloudburst', text: 'A sudden cloudburst: heavy rain for the next few laps' });
    }
    if (r() < per('storm')) { log.push({ kind: 'incident', inc: 'storm', text: 'Lightning in the area' }); if (s.lap >= s.laps * 0.75) ctx.endRace = true; else flagUp(ctx, 'red'); }
  }
  /* First lap and restarts: a tangle, or (rarely) a pile-up. */
  function startIncidents(s, R, r, track, field, log, ctx, restart) {
    var cm = (R.incidents || { crashes: 1 }).crashes * (1 + track) * (restart ? 0.4 : 1), n = field.length;
    var big = r() < INC.pileup.perStart * cm, tangle = !big && r() < INC.tangle.perStart * cm;
    if ((!big && !tangle) || n < 4) return;
    var m = big ? 5 + Math.floor(r() * 4) : 2 + Math.floor(r() * 4); m = Math.min(m, n - 1);
    var at = 1 + Math.floor(r() * Math.max(1, n - m)), who = field.slice(at, at + m), out = 0;
    log.push({ kind: 'incident', inc: big ? 'pileup' : 'tangle', ids: who.map(function (c) { return c.id; }), text: (big ? 'Multi-car pile-up' : ['Two', 'Three', 'Four', 'Five'][m - 2] + '-car tangle') + (restart ? ' at the restart' : ' at the first corner') + ': ' + who.map(function (c) { return c.driver.code; }).join(', ') });
    who.forEach(function (c) {
      var x = r();
      if (x < (big ? 0.55 : 0.35)) { retire(c, big ? 'Pile-up' : 'First-lap collision', log, s, big ? 'pileup' : 'tangle'); out++; }
      else if (x < 0.7) { limp(c, { pace: 1.4, laps: null, fix: true, inc: 'wing' }); needsPit(c, 9); c.cum += rr(r, 3, 8); log.push({ kind: 'damage', inc: 'wing', ids: [c.id], text: c.driver.code + ' has front wing damage and pits for a new nose' }); }
      else if (x < 0.85) { needsPit(c, 0); c.cum += rr(r, 10, 18); log.push({ kind: 'damage', inc: 'puncture', ids: [c.id], text: c.driver.code + ' has a puncture from the contact' }); }
      else { c.cum += rr(r, 4, 12); }
    });
    if (big || out >= 2) flagUp(ctx, big || r() < 0.35 ? 'red' : 'sc'); else flagUp(ctx, out ? 'sc' : 'vsc');
  }
  /* Two cars touch while racing: the follower (attacker) is usually to blame. */
  function contactIncident(car, ahead, s, R, r, log, ctx) {
    var x = r(), a = car.driver.code, b = ahead.driver.code;
    if (x < 0.45) { car.cum += rr(r, 1, 3); ahead.cum += rr(r, 1, 3); log.push({ kind: 'incident', inc: 'contact', ids: [car.id, ahead.id], text: a + ' and ' + b + ' touch, both lose time' }); if (r() < 0.3) penalise(car, 5, { inc: 'contact', text: 'causing a collision' }, log); return; }
    if (x < 0.65) { needsPit(ahead, 0); ahead.cum += rr(r, 12, 18); log.push({ kind: 'incident', inc: 'contact', ids: [car.id, ahead.id], text: a + ' hits ' + b + ', who gets a puncture' }); if (r() < 0.5) penalise(car, r() < 0.5 ? 5 : 10, { inc: 'contact', text: 'causing a collision' }, log); return; }
    if (x < 0.8) { limp(car, { pace: 1.4, laps: null, fix: true, inc: 'wing' }); needsPit(car, 9); log.push({ kind: 'incident', inc: 'contact', ids: [car.id, ahead.id], text: a + ' runs into the back of ' + b + ' and breaks the front wing' }); if (r() < 0.4) penalise(car, 5, { inc: 'contact', text: 'causing a collision' }, log); return; }
    if (x < 0.95) { var victim = r() < 0.5 ? ahead : car, other = victim === car ? ahead : car; retire(victim, 'Collision with ' + other.driver.code, log, s, 'contact'); log.push({ kind: 'incident', inc: 'contact', ids: [car.id, ahead.id], text: a + ' and ' + b + ' collide; ' + victim.driver.code + ' is out' }); flagUp(ctx, r() < 0.6 ? 'sc' : 'vsc'); if (car.status === 'running') penalise(car, 10, { inc: 'contact', text: 'causing a collision' }, log); return; }
    retire(car, 'Collision with ' + b, log, s, 'contact'); retire(ahead, 'Collision with ' + a, log, s, 'contact');
    log.push({ kind: 'incident', inc: 'contact', ids: [car.id, ahead.id], text: a + ' and ' + b + ' collide: both are out' }); flagUp(ctx, 'sc');
  }

  function retire(car, why, log, s, inc) {
    if (car.status !== 'running') return;
    car.status = 'dnf'; car.dnf = why; car.retiredLap = s.lap; car.limp = null;
    car.stints[car.stints.length - 1].to = s.lap;
    log.push({ kind: 'dnf', inc: inc || null, ids: [car.id], text: car.driver.code + ' out: ' + why });
  }

  function runTo(state, lap, callsByLap) {
    var s = state, log = [];
    while (!s.finished && s.lap < lap) {
      var out = stepLap(s, (callsByLap && callsByLap[s.lap + 1]) || []);
      s = out.state; log = log.concat(out.log);
    }
    return { state: s, log: log };
  }

  function classify(s) {
    var R = s.rules, run = order(s), lead = run[0], leadLap = lead ? lead.cum / Math.max(1, s.lap) : 1;
    var out = run.map(function (c, i) {
      var behind = c.cum - (lead ? lead.cum : 0), down = Math.floor(behind / leadLap);
      return { id: c.id, position: i + 1, status: 'finished', gap: i === 0 ? null : down >= 1 ? '+' + down + ' lap' + (down > 1 ? 's' : '') : '+' + behind.toFixed(3) + 's',
               time: c.cum, stops: c.stops, best: c.bestLap, grid: c.grid, points: R.points[i] || 0 };
    });
    var dnf = s.cars.filter(function (c) { return c.status !== 'running'; }).sort(function (a, b) { return (b.retiredLap || 0) - (a.retiredLap || 0); });
    dnf.forEach(function (c) { out.push({ id: c.id, position: null, status: 'dnf', gap: c.dnf, stops: c.stops, best: c.bestLap, grid: c.grid, points: 0, lap: c.retiredLap }); });
    return out;
  }

  var api = { momentOdds: momentOdds, COMPOUNDS: COMPOUNDS, MODES: MODES, TRACK: TRACK, DEFAULTS: DEFAULTS, rng: rng, carScore: carScore, tyreLife: tyreLife, composure: composure,
              weatherPlan: weatherPlan, INCIDENTS: INCIDENTS, qualify: qualify, createRace: createRace, stepLap: stepLap, runTo: runTo, classify: classify };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.RaceEngine = api;
})(typeof window !== 'undefined' ? window : this);

;
/* =====================================================================
   Formula Racing V3.0 data -> F1 SIM race engine inputs.
   Keeps the V3.0 attribute scales (so the admin ratings screen still
   makes sense) and translates them into what the lap-by-lap engine uses.
   Pure functions, no I/O.

     toCircuit(track)                 -> engine circuit
     toEntries(drivers, teams, track) -> engine entries
     weatherFor(track, mode)          -> engine weather
   ===================================================================== */
(function (root) {
  'use strict';

  /* V3.0 tracks have no lap times or pit-lane losses, which the engine needs
     for strategy. Approximate race-pace lap (s) and pit loss (s). */
  var LAP_REF = {
    australia: [82.5, 19], china: [98, 22], japan: [94, 22], bahrain: [96, 23], saudi: [92, 20],
    miami: [92, 20], spain: [78, 21], monaco: [75, 19], canada: [76, 18], austria: [69, 20],
    britain: [90, 20], hungary: [81, 20], belgium: [108, 18], netherlands: [74, 21], italy: [84, 24],
    azerbaijan: [106, 20], singapore: [96, 28], usa: [99, 20], mexico: [81, 22], brazil: [74, 21],
    lasvegas: [96, 20], qatar: [85, 25], abudhabi: [88, 22]
  };

  /* Which car qualities each circuit type rewards. */
  var TYPE_WEIGHTS = {
    'low-downforce':  { power: 0.60, aero: 0.20, grip: 0.20 },
    'high-speed':     { power: 0.40, aero: 0.45, grip: 0.15 },
    'high-downforce': { power: 0.20, aero: 0.55, grip: 0.25 },
    'technical':      { power: 0.20, aero: 0.40, grip: 0.40 },
    'street':         { power: 0.25, aero: 0.25, grip: 0.50 },
    'mixed':          { power: 0.35, aero: 0.35, grip: 0.30 }
  };

  /* V3.0 driving styles become small attribute changes. */
  var STYLES = {
    charger:    { aggression: 65, overtaking: 2 },
    aggressive: { aggression: 78 },
    qualifier:  { aggression: 55, qualiAdj: -0.12 },
    technical:  { aggression: 50, setup: 6 },
    smooth:     { aggression: 45, tyreMgmt: 5 },
    defender:   { aggression: 50, defense: 3 },
    strategist: { aggression: 50, tyreMgmt: 3, stretch: 1.04 },
    ironman:    { aggression: 45, consistency: 3 }
  };

  /* V3.0 team strategies, which used to scale a team's pace by up to 4%,
     become the AI strategist's habits instead. They change decisions, not speed. */
  var ARCHETYPES = {
    one_stop:       { label: 'One-stop',      stretch: 1.12, scPit: 0.50 },
    aggressive_two: { label: 'Aggressive two-stop', stretch: 0.80, scPit: 0.40 },
    undercut_king:  { label: 'Undercut',      stretch: 0.95, scPit: 0.45, undercut: true },
    overcut:        { label: 'Overcut',       stretch: 1.08, scPit: 0.60 },
    fuel_save:      { label: 'Lift and coast', stretch: 1.10, scPit: 0.45, startMode: 'manage', reliability: 3 },
    safety_car:     { label: 'Waits for a safety car', stretch: 1.06, scPit: 0.28 },
    tyre_banker:    { label: 'Tyre banker',   stretch: 1.00, scPit: 0.40, tyreLife: 4 },
    reactive:       { label: 'Reactive',      stretch: 1.00, scPit: 0.35 }
  };

  var clamp = function (x, lo, hi) { return Math.max(lo, Math.min(hi, x)); };

  function toCircuit(t) {
    var ref = LAP_REF[t.id] || [90, 21];
    return {
      id: t.id, name: t.circuit, race: t.name, laps: t.laps, baseLap: ref[0], pitLoss: ref[1],
      overtaking: clamp((100 - t.od) / 75, 0.12, 1.15),               // od: overtaking difficulty 0-100
      tyreStress: 0.55 + t.td / 100 * 0.6 + (t.abrasive || 3) * 0.03, // td: tyre degradation 0-100
      weights: TYPE_WEIGHTS[t.type] || TYPE_WEIGHTS.mixed,
      scChance: 0.003 + (t.street ? 0.006 : 0),
      wetRisk: t.wr, hasSprint: !!t.hasSprint, flag: t.flag
    };
  }

  /* Changeable weather uses the track's wet risk (wr, 0-100). */
  function weatherFor(t, mode) {
    if (mode === 'dry') return { start: 'dry' };
    return { mode: 'variable', rainChance: (t.wr || 0) / 100 * 0.6 };
  }

  /* V3.0 ratings are spread wide (car pace 67-96, driver pace 72-97). Compress
     them (spread, driverSpread) so the field covers about two seconds a lap and
     the midfield can still score; tune these rather than the ratings. */
  function toCar(team, spread) {
    var k = spread == null ? 0.45 : spread, base = 85 + (team.carPace - 82) * k;
    var arch = ARCHETYPES[team.strategy] || ARCHETYPES.reactive;
    return {
      power: base + ((team.topSpeed || 12) - 12.5) * 0.8,
      aero:  base + ((team.cornering || 12) - 12.5) * 0.8,
      grip:  base + ((team.cornering || 12) - 12.5) * 0.4,
      reliability: clamp((team.reliability || 75) + (arch.reliability || 0), 40, 99),
      pitSpeed: team.pitSpeed, tyreLife: (team.tyreLife || 75) + (arch.tyreLife || 0)
    };
  }

  function toDriver(d, spread) {
    var st = STYLES[d.style] || {}, k = spread == null ? 0.7 : spread;
    var tyreMgmt = Math.round(d.consistency * 0.6 + d.experience * 0.4) + (st.tyreMgmt || 0);
    return {
      code: d.abbr, name: d.name, num: d.num, flag: d.flag, style: d.style,
      pace: Math.round((85 + (d.pace - 85) * k) * 10) / 10, wet: d.wet, consistency: clamp(d.consistency + (st.consistency || 0), 1, 99),
      overtaking: clamp(d.overtaking + (st.overtaking || 0), 1, 99), defense: clamp(d.defense + (st.defense || 0), 1, 99),
      racecraft: Math.round((d.overtaking + d.defense) / 2), tyreMgmt: clamp(tyreMgmt, 1, 99),
      experience: d.experience, mental: d.mental, aggression: st.aggression || 50, rivals: d.rivals || []
    };
  }

  function toEntries(drivers, teams, track, opts) {
    opts = opts || {};
    var byTeam = {}; teams.forEach(function (t) { byTeam[t.id] = t; });
    return drivers.map(function (d) {
      var team = byTeam[d.teamId], st = STYLES[d.style] || {}, arch = ARCHETYPES[team.strategy] || ARCHETYPES.reactive;
      var affinity = (d.goodTracks || []).indexOf(track.id) >= 0 ? -0.15 : (d.badTracks || []).indexOf(track.id) >= 0 ? 0.15 : 0;
      return {
        id: d.abbr, team: team.id, driver: toDriver(d, opts.driverSpread), car: toCar(team, opts.spread),
        setup: (opts.setup && opts.setup[d.abbr] != null ? opts.setup[d.abbr] : 60) + (st.setup || 0),
        paceAdj: affinity, qualiAdj: st.qualiAdj || 0,
        ai: { stretch: arch.stretch * (st.stretch || 1), scPit: arch.scPit, undercut: !!arch.undercut },
        startMode: arch.startMode
      };
    });
  }

  var api = { LAP_REF: LAP_REF, TYPE_WEIGHTS: TYPE_WEIGHTS, STYLES: STYLES, ARCHETYPES: ARCHETYPES,
              toCircuit: toCircuit, toEntries: toEntries, toCar: toCar, toDriver: toDriver, weatherFor: weatherFor };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.FormulaRacingAdapter = api;
})(typeof window !== 'undefined' ? window : this);

;
/* =====================================================================
   F1 SIM — app core: state, data layer, shell, navigation and events.
   Storage comes from bridge.js as window.claude.use('db'): records by
   collection, live through Supabase Realtime.
   ===================================================================== */
'use strict';

const COLLECTIONS = ['characters', 'f1_teams', 'f1_people', 'f1_seats', 'f1_tracks', 'f1_weekends', 'f1_calls',
  'f1_applications', 'f1_posts', 'f1_settings', 'f1_runs', 'f1_projects', 'f1_dev', 'f1_plans',
  'f1_notices', 'f1_diary', 'f1_relations', 'f1_votes', 'f1_parts', 'f1_contracts', 'f1_series', 'f1_seasons', 'f1_branding', 'audit'];

const S = {
  phase: 'boot', store: {}, delivered: new Set(), db: null, uid: null, isGm: false, isOwner: false,
  route: 'home', charId: null, busy: false, navOpen: false,
  ui: { form: {}, drawer: null, confirm: null, toast: null }
};

/* ---------------------------------------------------------------- helpers */
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = s => s == null ? '' : String(s).replace(/[&<>"']/g, c => ESC[c]);
const nowIso = () => new Date().toISOString();
const newId = p => p + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
/* A character's ID comes from the database (CH- and eight letters and digits, checked against every character),
   or, where the database can't be asked, the same format made here with a secure random source. */
const CHAR_ID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
async function newCharId() {
  try { const db = await window.claude.use('db'); if (db && db.newCharacterId) { const id = await db.newCharacterId(); if (id && !get('characters', id)) return id; } } catch (e) { /* fall back below */ }
  for (;;) { const b = new Uint8Array(8); crypto.getRandomValues(b); const id = 'CH-' + Array.from(b, x => CHAR_ID_ALPHABET[x % 32]).join(''); if (!get('characters', id)) return id; }
}
const clone = o => o == null ? o : JSON.parse(JSON.stringify(o));
const plural = (n, w, pl) => n + ' ' + (n === 1 ? w : (pl || w + 's'));
const fmtDate = iso => iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
const fmtWhen = iso => iso ? new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
const list = col => Object.keys(S.store[col] || {}).map(id => Object.assign({}, S.store[col][id], { id }));
const get = (col, id) => id && S.store[col] && S.store[col][id] ? Object.assign({}, S.store[col][id], { id }) : null;
function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function lsSet(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { /* storage unavailable */ } }
function setPath(path, value) {
  const keys = path.split('/'); let o = S;
  for (let i = 0; i < keys.length - 1; i++) { if (o[keys[i]] == null || typeof o[keys[i]] !== 'object') o[keys[i]] = {}; o = o[keys[i]]; }
  o[keys[keys.length - 1]] = value;
}
const ACCOUNT = () => (typeof window !== 'undefined' && window.F1SIM_ACCOUNT) || null;

const ICONS = {
  menu: 'M3 6h18M3 12h18M3 18h18', x: 'M6 6l12 12M18 6L6 18', plus: 'M12 5v14M5 12h14',
  home: 'M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z', flag: 'M5 21V4M5 4h11l-2 4 2 4H5',
  radio: 'M4 15v-3a8 8 0 0 1 16 0v3M4 15h3v5H4zM17 15h3v5h-3z', star: 'M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z',
  users: 'M16 20v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 20v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8',
  news: 'M4 4h13v16H6a2 2 0 0 1-2-2zM17 8h3v10a2 2 0 0 1-2 2M8 8h5M8 12h5M8 16h3', shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z',
  server: 'M4 4h16v7H4zM4 13h16v7H4zM8 7.5h.01M8 16.5h.01', logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
  calendar: 'M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2',
  users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8',
  flask: 'M9 3h6M10 3v6l-5 9a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-9V3M7.5 15h9',
  bell: 'M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.9 1.9 0 0 0 3.4 0',
  wrench: 'M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z',
  user: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z'
};
const icon = (n, size) => `<svg class="ico" viewBox="0 0 24 24" width="${size || 18}" height="${size || 18}" aria-hidden="true"><path d="${ICONS[n] || ''}"/></svg>`;

/* ---------------------------------------------------------------- data layer */
const Data = {
  /* Writes apply to the local copy at once and roll back if the database refuses. */
  async put(col, id, data) {
    const bucket = S.store[col] = S.store[col] || {};
    const had = Object.prototype.hasOwnProperty.call(bucket, id), prev = bucket[id];
    bucket[id] = clone(data);
    /* A new character is inserted, never upserted: an ID already in use is refused instead of overwriting someone else. */
    try { const ref = S.db.collection(col).doc(id); if (col === 'characters' && !had && ref.create) await ref.create(data); else await ref.set(data); }
    catch (e) { if (had) bucket[id] = prev; else delete bucket[id]; throw e; }
  },
  async remove(col, id) {
    const bucket = S.store[col] || {}, prev = bucket[id];
    delete bucket[id];
    try { await S.db.collection(col).doc(id).delete(); }
    catch (e) { if (prev !== undefined) bucket[id] = prev; throw e; }
  },
  async audit(action, summary) {
    await Data.put('audit', newId('aud'), { at: nowIso(), userId: S.uid, actor: actorLabel(), action, summary });
  }
};
function actorLabel() { const c = currentChar(); const a = ACCOUNT(); return S.isGm ? 'Race Control' + (a ? ` (${a.username})` : '') : (c ? c.name : (a ? a.username : 'player')); }

function toast(msg, bad) {
  S.ui.toast = { msg, bad: !!bad }; renderOverlay();
  clearTimeout(toast.t); toast.t = setTimeout(() => { S.ui.toast = null; renderOverlay(); }, bad ? 6000 : 3200);
}
/* Run a write sequence with one busy flag and a readable failure message. */
async function run(fn, okMsg) {
  if (S.busy) return false;
  S.busy = true; render();
  let ok = false;
  try { await fn(); ok = true; if (okMsg) toast(okMsg); }
  catch (e) {
    const code = e && e.code;
    if (code === 'not_granted') toast('Your account isn’t allowed to change this. Ask Race Control.', true);
    else if (code === 'quota_exceeded') toast('The database is full. Download a backup and remove old race weekends, or move to a larger Supabase plan.', true);
    else toast('Couldn’t save: ' + ((e && e.message) || 'unknown error') + '. Try again.', true);
  } finally { S.busy = false; render(); }
  return ok;
}
function askConfirm(message, confirmText, action, danger) { S.ui.confirm = { message, confirmText, action, danger: !!danger }; renderOverlay(); }

/* ---------------------------------------------------------------- characters */
const CHAR_ROLES = [['driver', 'Driver'], ['principal', 'Team principal'], ['engineer', 'Race engineer'], ['media', 'Media'], ['paddock', 'Paddock life']];
const charRoleName = k => (CHAR_ROLES.find(r => r[0] === k) || [k, k])[1];
const myChars = () => list('characters').filter(c => c.userId === S.uid && !c.retired).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
/* Race Control can view and act as any character ("View as"); players only as their own. */
const currentChar = () => { const c = get('characters', S.charId); return c && !c.retired && (c.userId === S.uid || S.isGm) ? c : null; };
const actingForOther = () => { const c = currentChar(); return !!(c && c.userId !== S.uid); };
/* Records made as a character belong to that character's player, even when Race Control makes them. */
const asOwner = () => { const c = currentChar(); return (c && c.userId) || S.uid; };
function resolveChar() {
  const mine = myChars(), saved = lsGet('f1sim.char');
  if (S.isGm) { const c = get('characters', saved); S.charId = c && !c.retired ? c.id : null; return; }
  S.charId = (mine.find(c => c.id === saved) || mine[0] || {}).id || null;
}

/* ---------------------------------------------------------------- routes, actions, drawers */
const ROUTES = {}, ACTIONS = {}, CHANGES = {}, DRAWERS = {};
function route(name, title, view, opts) { ROUTES[name] = Object.assign({ title, view }, opts || {}); }
function openDrawer(type, extra) { S.ui.drawer = Object.assign({ type }, extra || {}); renderOverlay(); }
function closeDrawer() { S.ui.drawer = null; renderOverlay(); }
function go(r) { if (!ROUTES[r]) r = 'home'; S.route = r; S.navOpen = false; S.ui.drawer = null; if (location.hash.slice(1) !== r) history.replaceState(null, '', '#' + r); render(); window.scrollTo(0, 0); }

const NAV = [
  ['home', 'home', 'Home'], ['notices', 'bell', 'Notifications'], ['grid', 'flag', 'The Grid'], ['team', 'wrench', 'Team HQ'], ['weekend', 'radio', 'Race Weekend'], ['calendar', 'calendar', 'Calendar'], ['test', 'flask', 'Test Track'], ['standings', 'star', 'Championship'], ['seasons', 'star', 'Seasons'], ['people', 'users', 'Characters'],
  ['paddock', 'news', 'Paddock'], ['characters', 'user', 'Your characters']
];
const NAV_RC = [['control', 'shield', 'Race Control'], ['admin', 'server', 'Accounts and backups']];
function navHtml() {
  const item = ([r, ic, label, count]) => `<button class="nav-item" data-act="nav" data-route="${r}" ${S.route === r ? 'aria-current="page"' : ''}>${icon(ic)}<span>${esc(label)}</span>${count ? `<span class="count">${count}</span>` : ''}</button>`;
  const pending = S.isGm ? list('f1_applications').filter(a => a.status === 'pending').length + list('characters').filter(c => !c.retired && c.status === 'pending').length : 0;
  const unread = typeof unreadCount === 'function' ? unreadCount() : 0;
  let h = `<div class="nav-group">${NAV.map(x => item(x[0] === 'notices' ? [x[0], x[1], x[2], unread] : x)).join('')}</div>`;
  if (S.isGm) h += `<div class="nav-group rc"><p class="nav-h">Race Control</p>${item(['control', 'shield', 'Race Control', pending])}${item(['series', 'flag', 'Series'])}${S.isOwner ? item(NAV_RC[1]) : ''}</div>`;
  /* The version the site is running, to match against CHANGELOG.md and the commits. */
  if (window.F1SIM_VERSION && window.F1SIM_VERSION.indexOf('__') !== 0) h += `<p class="nav-version">F1 SIM v${esc(window.F1SIM_VERSION)}</p>`;
  return h;
}
function topbarHtml() {
  const a = ACCOUNT(), mine = myChars(), c = currentChar();
  const all = S.isGm ? list('characters').filter(x => !x.retired).sort((x, y) => String(x.name).localeCompare(String(y.name))) : [];
  const who = S.isGm ? `<label class="who"><span class="sr-only">View as</span><select id="char-switch" data-change="char-switch" title="See the league as any character">
      <option value="">Race Control view</option>${mine.length ? `<optgroup label="Your characters">${mine.map(x => `<option value="${esc(x.id)}" ${x.id === S.charId ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</optgroup>` : ''}
      <optgroup label="View as a player’s character">${all.filter(x => x.userId !== S.uid).map(x => `<option value="${esc(x.id)}" ${x.id === S.charId ? 'selected' : ''}>${esc(x.name)} (${esc(charRoleName(x.role).toLowerCase())})</option>`).join('')}</optgroup></select></label>`
    : mine.length > 1 ? `<label class="who"><span class="sr-only">Playing as</span><select id="char-switch" data-change="char-switch">${mine.map(x => `<option value="${esc(x.id)}" ${x.id === S.charId ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>`
    : c ? `<span class="who">${esc(c.name)}</span>` : '';
  return `<button class="menu-btn" data-act="nav-toggle" aria-label="${S.navOpen ? 'Close' : 'Open'} the menu" aria-expanded="${S.navOpen}">${icon(S.navOpen ? 'x' : 'menu', 22)}</button>
    <button class="brand" data-act="nav" data-route="home">${typeof leagueLogo === 'function' && leagueLogo() ? `<img class="league-logo" src="${esc(leagueLogo())}" alt="">` : '<span class="brand-mark" aria-hidden="true"></span>'}F1 SIM</button>
    ${typeof topNavHtml === 'function' ? topNavHtml() : (typeof seriesSwitchHtml === 'function' ? seriesSwitchHtml() : '')}
    <div class="top-right">${S.isGm ? '<span class="rc-badge">Race Control</span>' : ''}${(() => { const n = typeof unreadCount === 'function' ? unreadCount() : 0; return `<button class="bell" data-act="nav" data-route="notices" aria-label="Notifications${n ? ', ' + n + ' new' : ''}">${icon('bell', 20)}${n ? `<span class="count">${n}</span>` : ''}</button>`; })()}${who}
      ${a ? `<button class="btn ghost small" data-act="sign-out" title="Signed in as ${esc(a.username)}">${icon('logout', 16)}<span class="hide-s">Sign out</span></button>` : ''}</div>`;
}

/* ---------------------------------------------------------------- rendering */
let renderQueued = false;
function scheduleRender() { if (renderQueued) return; renderQueued = true; requestAnimationFrame(() => { renderQueued = false; render(); }); }
function bootHtml(title, body) { return `<div class="boot"><div class="boot-card"><span class="brand-mark big" aria-hidden="true"></span><h1>${title}</h1><p>${body}</p></div></div>`; }
function render() {
  const app = document.getElementById('app');
  if (S.phase !== 'ready') {
    app.innerHTML = S.phase === 'boot' ? bootHtml('Connecting', 'Loading the grid, the calendar and the paddock.')
      : S.phase === 'timeout' ? bootHtml('Still connecting', 'The database is slow to answer. The league opens as soon as the data arrives.')
      : bootHtml('Can’t open the league', 'Sign in again, or check that the database set-up has run.');
    renderOverlay(); return;
  }
  const ae = document.activeElement, fid = ae && ae.id ? ae.id : null;
  let sel = null; try { if (fid && ae.selectionStart != null) sel = [ae.selectionStart, ae.selectionEnd]; } catch (e) { sel = null; }
  if (!app.querySelector('.shell')) app.innerHTML = `<div class="shell"><header class="topbar" id="topbar"></header><nav class="side" id="side" aria-label="Main"></nav><main class="main" id="main" tabindex="-1"></main></div>`;
  app.querySelector('.shell').classList.toggle('nav-open', S.navOpen);
  document.getElementById('topbar').innerHTML = topbarHtml();
  document.getElementById('side').innerHTML = navHtml();
  if (typeof playerLimited === 'function' && playerLimited() && LIMITED_ROUTES.indexOf(S.route) === -1) S.route = 'home';
  const r = ROUTES[S.route] || ROUTES.home;
  let body;
  if (r.gm && !S.isGm) body = '<div class="empty">This page is for Race Control.</div>';
  else if (r.owner && !S.isOwner) body = '<div class="empty">This page is for the Administrator.</div>';
  else { try { body = r.view(); } catch (e) { console.error(e); body = `<div class="empty">This page couldn’t be shown: ${esc(e.message)}</div>`; } }
  const vb = actingForOther() ? `<div class="view-as">Viewing as <b>${esc(currentChar().name)}</b>, a player’s character. What you do here counts as them. <button class="btn small" data-act="view-as-stop">Back to Race Control</button></div>` : '';
  document.getElementById('main').innerHTML = `<div class="page">${vb}${body}</div>`;
  document.title = `${r.title} · F1 SIM`;
  renderOverlay();
  if (fid) { const el = document.getElementById(fid); if (el) { el.focus({ preventScroll: true }); if (sel) { try { el.setSelectionRange(sel[0], sel[1]); } catch (e) { /* not text */ } } } }
}
function renderOverlay() {
  let ov = document.getElementById('overlay');
  if (!ov) { ov = document.createElement('div'); ov.id = 'overlay'; document.body.appendChild(ov); }
  const db = ov.querySelector('.drawer .body'), keep = db ? db.scrollTop : 0;
  let h = '';
  if (S.ui.drawer && DRAWERS[S.ui.drawer.type]) h += `<div class="scrim" data-act="close-drawer"></div><section class="drawer" role="dialog" aria-modal="true" aria-label="Details">${DRAWERS[S.ui.drawer.type](S.ui.drawer)}</section>`;
  if (S.ui.confirm) { const c = S.ui.confirm; h += `<div class="scrim"></div><div class="dialog" role="alertdialog" aria-modal="true" aria-labelledby="cf-msg"><p id="cf-msg">${esc(c.message)}</p>
    <div class="btn-row"><button class="btn ${c.danger ? 'danger' : 'primary'}" data-act="confirm-ok" id="confirm-ok">${esc(c.confirmText)}</button><button class="btn" data-act="confirm-cancel">Cancel</button></div></div>`; }
  if (S.ui.toast) h += `<div class="toast ${S.ui.toast.bad ? 'bad' : ''}" role="status">${esc(S.ui.toast.msg)}</div>`;
  const focusedInOverlay = ov.contains(document.activeElement) ? document.activeElement.id : null;
  ov.innerHTML = h;
  const db2 = ov.querySelector('.drawer .body'); if (db2) db2.scrollTop = keep;
  if (focusedInOverlay) { const el = document.getElementById(focusedInOverlay); if (el) el.focus({ preventScroll: true }); }
  else if (S.ui.confirm) { const ok = document.getElementById('confirm-ok'); if (ok) ok.focus(); }
}

/* ---------------------------------------------------------------- events
   Typed fields (data-bind) store their value on every keystroke and never redraw:
   a redraw between pressing and releasing a button would swallow the click.
   Selects and checkboxes with data-bind redraw on change, because what they pick
   usually changes what's shown. */
function bindValue(el) {
  let v = el.type === 'checkbox' ? el.checked : el.value;
  if (el.dataset.type === 'number' && el.type !== 'checkbox') v = v === '' ? null : Number(v);
  setPath(el.dataset.bind, v);
}
document.addEventListener('click', e => {
  const el = e.target.closest && e.target.closest('[data-act]');
  if (!el || (el.tagName === 'INPUT' && el.type === 'checkbox')) return;
  const fn = ACTIONS[el.dataset.act];
  if (fn) { e.preventDefault(); fn(el.dataset, el, e); }
});
document.addEventListener('input', e => { const el = e.target; if (el.dataset && el.dataset.bind && el.tagName !== 'SELECT' && el.type !== 'checkbox') bindValue(el); });
document.addEventListener('change', e => {
  const el = e.target; if (!el.dataset) return;
  if (el.type === 'checkbox' && el.dataset.act) { ACTIONS[el.dataset.act](el.dataset, el); return; }
  if (el.dataset.bind) { bindValue(el); if (el.tagName === 'SELECT' || el.type === 'checkbox') render(); return; }
  if (el.dataset.change && CHANGES[el.dataset.change]) CHANGES[el.dataset.change](el.value, el.dataset, el);
});
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (S.ui.confirm) { S.ui.confirm = null; renderOverlay(); } else if (S.ui.drawer) closeDrawer(); else if (S.navOpen) { S.navOpen = false; render(); }
});
window.addEventListener('hashchange', () => { const h = location.hash.slice(1); if (ROUTES[h] && h !== S.route) go(h); });

Object.assign(ACTIONS, {
  nav: d => go(d.route),
  'nav-toggle': () => { S.navOpen = !S.navOpen; render(); },
  'close-drawer': () => closeDrawer(),
  'confirm-ok': () => { const a = S.ui.confirm.action; S.ui.confirm = null; renderOverlay(); a(); },
  'confirm-cancel': () => { S.ui.confirm = null; renderOverlay(); },
  'sign-out': () => { const a = ACCOUNT(); if (a) a.signOut(); },
  'view-as-stop': () => { S.charId = null; lsSet('f1sim.char', null); render(); }
});
CHANGES['char-switch'] = v => { S.charId = v || null; lsSet('f1sim.char', v || null); render(); };

/* ---------------------------------------------------------------- boot */
async function init() {
  render();
  const c = window.claude;
  if (!c || typeof c.use !== 'function') { S.phase = 'nodb'; render(); return; }
  const timer = setTimeout(() => { if (S.phase === 'boot') { S.phase = 'timeout'; render(); } }, 10000);
  let db = null, user = null;
  try { [db, user] = await Promise.all([c.use('db'), c.use('user')]); } catch (e) { db = null; }
  if (!db) { clearTimeout(timer); S.phase = 'nodb'; render(); return; }
  S.db = db;
  try { S.isGm = !!(await user.canEdit()); S.uid = await user.id(); S.isOwner = !!(await user.isOwner()); } catch (e) { /* treat as player */ }
  COLLECTIONS.forEach(col => {
    db.collection(col).onSnapshot(snap => {
      const m = {}; snap.docs.forEach(d => { m[d.id] = d.data(); });
      S.store[col] = m; S.delivered.add(col);
      if (S.phase !== 'ready' && S.delivered.size === COLLECTIONS.length) {
        clearTimeout(timer); S.phase = 'ready'; resolveChar();
        const h = location.hash.slice(1); S.route = ROUTES[h] ? h : 'home';
      }
      if (col === 'characters' && S.phase === 'ready' && !currentChar()) resolveChar();
      scheduleRender();
    }, () => { S.delivered.add(col); scheduleRender(); });
  });
}

/* ---------------------------------------------------------------- Your characters */
const CHAR_BLANK = { name: '', code: '', number: '', nationality: '', role: 'driver', bio: '', discord: '', faceclaim: '', personality: '', portraitUrl: null, nickname: '', birthplace: '', junior: '', helmet: '' };
ACTIONS['char-new'] = () => { S.ui.form.ch = Object.assign({}, CHAR_BLANK); go('newchar'); };
ACTIONS['char-edit'] = d => { const c = get('characters', d.id); if (!c) return; S.ui.form.ch = Object.assign({}, CHAR_BLANK, clone(S.store.characters[d.id]), { id: d.id }); openDrawer('char'); };
ACTIONS['char-play'] = d => { S.charId = d.id; lsSet('f1sim.char', d.id); toast('Now playing as ' + ((get('characters', d.id) || {}).name || 'this character') + '.'); render(); };
ACTIONS['ch-pref-first'] = d => {
  const f = S.ui.form.ch || {}, tp = Object.assign({}, f.teamPref || {});
  if (tp.first === d.team) { tp.first = ''; tp.seat = ''; } else { tp.first = d.team; if (tp.second === d.team) tp.second = ''; tp.seat = ''; }
  S.ui.form.ch = Object.assign({}, f, { teamPref: tp }); render();
};
ACTIONS['ch-pref-seat'] = d => {
  const f = S.ui.form.ch || {}, tp = Object.assign({}, f.teamPref || {});
  tp.seat = d.seat || '';
  S.ui.form.ch = Object.assign({}, f, { teamPref: tp }); render();
};
ACTIONS['ch-role-btn'] = d => {
  if (S.ui.form.ch) { S.ui.form.ch.role = d.role; renderOverlay(); if (S.ui.charInline || S.route === 'newchar') render(); }
};
/* The character form's fields. skipRole=true omits the role tiles (newchar page renders them separately). */
function charFormFields(f, skipRole) {
  const txt = (k, label, extra) => `<label class="field">${label}<input id="ch-${k}" type="text" data-bind="ui/form/ch/${k}" value="${esc(f[k] || '')}" ${extra || ''}></label>`;
  return `<div class="ch-photo-row"><div class="ch-photo">${f.portraitUrl ? `<img src="${esc(f.portraitUrl)}" alt="The character's picture">` : '<span class="muted small">No picture yet</span>'}</div>
      <div><h3>Picture and face claim</h3><div class="btn-row"><label class="btn small file-btn">${f.portraitUrl ? 'Change the picture' : 'Upload a picture'}<input type="file" accept="image/*" class="sr-only" data-change="ch-portrait"></label>${f.portraitUrl ? '<button class="btn small ghost" data-act="ch-portrait-remove">Remove</button>' : ''}${S.ui.chUploading ? '<span class="muted small">Uploading…</span>' : ''}</div>
      <p class="muted small">JPEG, PNG or WebP; a head-and-shoulders shot works best. It's saved with the character.</p>
      ${txt('faceclaim', 'Face claim', 'placeholder="Who the picture shows, e.g. the actor or model" autocomplete="off"')}</div></div>
    <div class="form-grid">
      ${txt('name', 'Name', 'autocomplete="off" required')}
      ${skipRole ? '' : (() => { const locked = f.id && charStatus(get('characters', f.id) || {}) === 'approved'; return `<div class="field" style="grid-column:1/-1">What they do<div class="role-tiles">${CHAR_ROLES.map(([k, l]) => locked ? `<span class="role-tile${(f.role || 'driver') === k ? ' on' : ''}">${esc(l)}</span>` : `<button class="role-tile${(f.role || 'driver') === k ? ' on' : ''}" data-act="ch-role-btn" data-role="${esc(k)}" type="button" aria-pressed="${(f.role || 'driver') === k}">${esc(l)}</button>`).join('')}</div>${locked ? '<span class="muted small" style="margin-top:4px">Fixed once approved; ask Race Control to change it.</span>' : ''}</div>`; })()}
      ${txt('nationality', 'Nationality', 'placeholder="e.g. Scottish"')}
      ${f.role === 'driver' ? txt('code', 'Three-letter code (drivers)', 'maxlength="3" placeholder="e.g. HAR"') + `<label class="field">Car number (drivers)<input id="ch-number" type="number" min="1" max="99" data-bind="ui/form/ch/number" data-type="number" value="${esc(f.number || '')}"></label>` : ''}
      ${txt('discord', 'Discord username (for @mentions)', 'autocomplete="off" placeholder="e.g. amelia.hart"')}
      ${txt('nickname', 'Nickname (optional)')}${txt('birthplace', 'Where they\'re from (optional)')}
    </div>
    <label class="field">Personality<textarea id="ch-personality" rows="4" maxlength="4000" data-bind="ui/form/ch/personality" placeholder="How they come across: temperament, quirks, how they handle pressure, the media and their team-mate">${esc(f.personality || '')}</textarea></label>
    <label class="field">Backstory<textarea id="ch-bio" rows="6" data-bind="ui/form/ch/bio" placeholder="Where they come from and how they got into the paddock">${esc(f.bio || '')}</textarea></label>
    ${f.role === 'driver' ? `<label class="field">Before Formula 1 (optional)<textarea id="ch-junior" rows="3" data-bind="ui/form/ch/junior" placeholder="Karting, junior series, titles, the one that got away">${esc(f.junior || '')}</textarea></label>
    ${txt('helmet', 'Helmet design (optional)', 'placeholder="e.g. Saltire blue with a gold stripe"')}` : ''}

    ${typeof flavourFieldsHtml === 'function' ? flavourFieldsHtml(f) : ''}`;
}
CHANGES['ch-newchar-series'] = v => { S.ui.newcharSeries = v; render(); };
function charDrawerPrefHtml(f) {
  if (PREF_ROLES.indexOf(f.role || 'driver') === -1) return '';
  const tp = f.teamPref || {}, role = f.role === 'principal' ? 'principal' : f.role === 'engineer' ? 'engineer' : 'driver';
  const roleWord = { driver: 'seats', engineer: 'engineer posts', principal: 'principal post' }[role];
  const sid = S.ui.newcharSeries || (tp.first ? ((get('f1_teams', tp.first) || {}).seriesId || 'f1') : 'f1');
  const seriesList = allSeries().filter(s => list('f1_teams').some(t => (t.seriesId || 'f1') === s.id));
  const teams = list('f1_teams').filter(t => (t.seriesId || 'f1') === sid).sort((a, b) => (a.order || 0) - (b.order || 0));
  if (!teams.length) return '';
  const card = t => { const seats = list('f1_seats').filter(s => s.teamId === t.id && s.role === role), held = seats.filter(s => s.holderCharId).length;
    return `<button class="card tp-team ${tp.first === t.id ? 'on' : ''}" style="--team:${esc(t.color || '#888')}" data-act="ch-pref-first" data-team="${esc(t.id)}" aria-pressed="${tp.first === t.id}">
      <b>${esc(t.name)}</b><span class="muted small">${seats.length ? (held ? `${held} of ${seats.length} ${roleWord} held` : (seats.length === 1 ? 'Open to players' : `All ${seats.length} open`)) : ''}</span></button>`; };
  const seatPicker = tp.first && role !== 'principal' ? (() => {
    const firstSeats = list('f1_seats').filter(s => s.teamId === tp.first && s.role === role).sort((a, b) => (a.order || 0) - (b.order || 0));
    if (firstSeats.length < 2) return '';
    return `<div class="field" style="margin-top:12px">Which seat<div class="role-tiles">
      ${firstSeats.map((s, i) => `<button class="role-tile${tp.seat === s.id ? ' on' : ''}" data-act="ch-pref-seat" data-seat="${esc(s.id)}" type="button" aria-pressed="${tp.seat === s.id}">Seat ${i + 1}<span class="seat-status">${s.holderCharId ? 'held' : 'open'}</span></button>`).join('')}
      <button class="role-tile${!tp.seat ? ' on' : ''}" data-act="ch-pref-seat" data-seat="" type="button" aria-pressed="${!tp.seat}">No preference<span class="seat-status">&nbsp;</span></button>
    </div></div>`;
  })() : '';
  return `<div class="ch-pref-section"><h3>Team preference</h3>
    <p class="muted small">Pick your first choice. Race Control makes the final call when they review your application.</p>
    ${seriesList.length > 1 ? `<label class="field" style="max-width:280px">Series<select data-change="ch-newchar-series">${seriesList.map(s => `<option value="${esc(s.id)}" ${s.id === sid ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>` : ''}
    <div class="tp-grid">${teams.map(card).join('')}</div>
    ${seatPicker}
    ${tp.first ? `<div class="form-grid" style="margin-top:12px">
      <label class="field">Second choice<select data-bind="ui/form/ch/teamPref/second"><option value="">None</option>${teams.filter(t => t.id !== tp.first).map(t => `<option value="${esc(t.id)}" ${tp.second === t.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></label>
      <label class="field">Why this team? (optional)<input type="text" maxlength="200" data-bind="ui/form/ch/teamPref/why" value="${esc(tp.why || '')}" placeholder="e.g. grew up watching them"></label>
    </div>` : ''}
    <label class="small" style="margin-top:8px"><input type="checkbox" data-bind="ui/form/ch/teamPref/any" ${tp.any ? 'checked' : ''}> Happy to go to any team</label>
  </div>`;
}
DRAWERS.char = function () {
  const f = S.ui.form.ch || {};
  return `<header><div><h2>Edit character</h2><p>Characters are fiction.</p></div>
      <button class="btn ghost" data-act="close-drawer">Close</button></header>
    <div class="body">${charFormFields(f)}
    <div class="btn-row"><button class="btn primary" data-act="char-save">Save changes</button>${f.id ? `<button class="btn danger" data-act="char-retire" data-id="${esc(f.id)}">Retire this character</button>` : ''}</div></div>`;
};
route('newchar', 'New character', function () {
  const f = S.ui.form.ch || (S.ui.form.ch = Object.assign({}, CHAR_BLANK));
  if (f.id) { go('character'); return ''; }
  const stepBtn = (n, label, active) => `<button class="newchar-step ${active ? 'now' : 'next'}" ${active ? 'aria-current="step"' : `data-act="char-save" title="Save and go to ${label}"`} type="button"><span class="step-num">${n}</span><span class="step-name">${label}</span></button>`;
  const locked = f.id && charStatus(get('characters', f.id) || {}) === 'approved';
  const roleTilesHtml = `<div class="field">What they do<div class="role-tiles">${CHAR_ROLES.map(([k, l]) => locked ? `<span class="role-tile${(f.role || 'driver') === k ? ' on' : ''}">${esc(l)}</span>` : `<button class="role-tile${(f.role || 'driver') === k ? ' on' : ''}" data-act="ch-role-btn" data-role="${esc(k)}" type="button" aria-pressed="${(f.role || 'driver') === k}">${esc(l)}</button>`).join('')}</div>${locked ? '<span class="muted small" style="margin-top:4px">Fixed once approved; ask Race Control to change it.</span>' : ''}</div>`;
  const teamPrefHtml = charDrawerPrefHtml(f);
  return `<div class="page-head"><div><h1>New character</h1>
      <p>Fill in who they are and pick a team. You can keep editing and add their story on the next page.</p></div></div>
    <nav class="newchar-stepper" aria-label="Application steps">
      ${stepBtn(1, 'About them', true)}
      <span class="step-line" aria-hidden="true"></span>
      ${stepBtn(2, 'Background & ratings', false)}
      <span class="step-line" aria-hidden="true"></span>
      ${stepBtn(3, 'Submit to Race Control', false)}
    </nav>
    <section class="card">${roleTilesHtml}</section>
    ${teamPrefHtml ? `<section class="card">${teamPrefHtml}</section>` : ''}
    <section class="card">${charFormFields(f, true)}</section>
    <div class="newchar-sticky">
      <span class="muted small">Name is required to create</span>
      <div class="btn-row" style="margin:0">
        <button class="btn ghost" data-act="nav" data-route="characters">Cancel</button>
        <button class="btn primary" data-act="char-save">Create character</button>
      </div>
    </div>`;
});
ACTIONS['char-save'] = () => {
  const f = clone(S.ui.form.ch || {}); let id = f.id || null; delete f.id;
  f.name = String(f.name || '').trim();
  if (!f.name) { toast('Give your character a name.', true); return; }
  f.code = String(f.code || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3);
  f.discord = String(f.discord || '').trim().replace(/^@+/, '').replace(/\s+/g, '');
  delete f.discordId;
  const prev = id ? get('characters', id) : null;
  if (prev && charStatus(prev) === 'approved') f.role = prev.role;
  const doc = Object.assign({}, prev ? clone(S.store.characters[id]) : { createdAt: nowIso() }, f, { userId: prev ? prev.userId : S.uid, updatedAt: nowIso() });
  run(async () => {
    if (!id) { id = await newCharId(); doc.id = id; }
    await Data.put('characters', id, doc);
    S.ui.charInline = null;
    /* An approved character's name, code and number also change on the grid. */
    const pid = f1PcId(id), person = prev && F1.person(pid);
    if (person && (person.name !== doc.name || person.abbr !== (doc.code || person.abbr) || (person.num || null) !== (doc.number || null))) {
      await Data.put('f1_people', pid, Object.assign(clone(S.store.f1_people[pid]), { name: doc.name, abbr: doc.code || person.abbr, num: doc.number || null }));
      for (const s of list('f1_seats').filter(x => x.holderCharId === id)) await Data.put('f1_seats', s.id, Object.assign(clone(S.store.f1_seats[s.id]), { holderName: doc.name }));
    }
    if (!prev) { if (!S.isGm || !S.charId) { S.charId = id; lsSet('f1sim.char', id); } await Data.audit('character.new', `${doc.name} started an application as ${charRoleName(doc.role).toLowerCase()}`); }
    closeDrawer();
    if (!prev) { S.ui.charEdit = id; go('character'); }
  }, prev ? 'Character saved.' : 'Character started. Next: their application.');
};
ACTIONS['char-retire'] = d => askConfirm('Retire this character? They leave any seat they hold and stop appearing in your list. Their race results stay in the record books.', 'Retire', () => run(async () => {
  const c = clone(S.store.characters[d.id]); c.retired = true; c.retiredAt = nowIso();
  for (const s of list('f1_seats').filter(x => x.holderCharId === d.id)) await Data.put('f1_seats', s.id, Object.assign(clone(S.store.f1_seats[s.id]), { holderCharId: null, holderName: null, holderSince: null }));
  await Data.put('characters', d.id, c); closeDrawer(); resolveChar();
}, 'Character retired.'), true);

route('characters', 'Your characters', function () {
  const mine = myChars();
  const card = c => { const seat = charSeat(c.id), t = seat ? get('f1_teams', seat.teamId) : null;
    return `<article class="card char-card ${c.id === S.charId ? 'active' : ''}" ${t ? `style="--team:${esc(t.color)}"` : ''}>
      <h2>${esc(c.name)}</h2><p><span class="tag ${charStatus(c) === 'approved' ? 'player' : charStatus(c) === 'pending' ? 'open' : charStatus(c) === 'returned' ? 'flag' : ''}">${esc(STATUS_TEXT[charStatus(c)])}</span></p><p class="meta">${esc(charRoleName(c.role))}${c.nationality ? ', ' + esc(c.nationality) : ''}${c.code ? `, ${esc(c.code)}` : ''}${c.number ? ` #${esc(c.number)}` : ''}</p>
      <p>${seat ? `<b>${esc(seatTitle(seat))}, ${esc(t ? t.name : '')}</b>` : '<span class="muted">No seat yet</span>'}</p>
      ${c.bio ? `<p class="bio">${esc(c.bio.slice(0, 220))}${c.bio.length > 220 ? '…' : ''}</p>` : ''}
      <div class="btn-row">${c.id === S.charId ? '<span class="tag on">Playing now</span>' : `<button class="btn small primary" data-act="char-play" data-id="${esc(c.id)}">Play as ${esc(c.name.split(' ')[0])}</button>`}
        <button class="btn small ${charStatus(c) === 'approved' ? '' : 'primary'}" data-act="char-open" data-id="${esc(c.id)}">${charStatus(c) === 'approved' ? 'Open' : charStatus(c) === 'pending' ? 'View the application' : 'Continue the application'}</button></div></article>`; };
  return `<div class="page-head"><div><h1>Your characters</h1><p>Drivers, team principals, race engineers, journalists and everyone else in the paddock. Each starts as an application to Race Control; drivers roll their ratings. Play as one at a time.</p></div>
      <button class="btn primary" data-act="char-new">${icon('plus', 16)} New character</button></div>
    ${mine.length ? `<div class="cards">${mine.map(card).join('')}</div>` : `<div class="card empty-card"><h2>Make your first character</h2><p>Start with who they are and what they do. A driver or team principal can apply for a seat on The Grid once they exist.</p><button class="btn primary" data-act="char-new">Create a character</button></div>`}`;
});

const F1_DEFAULTS = {"teams":[{"id":"mclaren","name":"McLaren","abbr":"MCL","color":"#FF8000","strategy":"aggressive_two","carPace":96,"reliability":88,"pitSpeed":92,"tyreLife":82,"cornering":18,"topSpeed":14,"order":1,"powerUnit":"Mercedes"},{"id":"ferrari","name":"Ferrari","abbr":"FER","color":"#E8002D","strategy":"overcut","carPace":93,"reliability":84,"pitSpeed":87,"tyreLife":76,"cornering":16,"topSpeed":16,"order":2,"powerUnit":"Ferrari"},{"id":"redbull","name":"Red Bull","abbr":"RBR","color":"#3671C6","strategy":"one_stop","carPace":91,"reliability":83,"pitSpeed":95,"tyreLife":79,"cornering":16,"topSpeed":15,"order":3,"powerUnit":"Red Bull Ford"},{"id":"mercedes","name":"Mercedes","abbr":"MER","color":"#00D2BE","strategy":"undercut_king","carPace":89,"reliability":91,"pitSpeed":88,"tyreLife":83,"cornering":14,"topSpeed":14,"order":4,"powerUnit":"Mercedes"},{"id":"williams","name":"Williams","abbr":"WIL","color":"#37BEDD","strategy":"fuel_save","carPace":82,"reliability":82,"pitSpeed":83,"tyreLife":78,"cornering":11,"topSpeed":13,"order":5,"powerUnit":"Mercedes"},{"id":"racingbulls","name":"Racing Bulls","abbr":"RBX","color":"#6692FF","strategy":"reactive","carPace":81,"reliability":79,"pitSpeed":84,"tyreLife":74,"cornering":12,"topSpeed":13,"order":6,"powerUnit":"Red Bull Ford"},{"id":"astonmartin","name":"Aston Martin","abbr":"AMR","color":"#358C75","strategy":"safety_car","carPace":79,"reliability":80,"pitSpeed":82,"tyreLife":75,"cornering":12,"topSpeed":12,"order":7,"powerUnit":"Honda"},{"id":"alpine","name":"Alpine","abbr":"ALP","color":"#0093CC","strategy":"reactive","carPace":77,"reliability":77,"pitSpeed":79,"tyreLife":72,"cornering":10,"topSpeed":12,"order":8,"powerUnit":"Mercedes"},{"id":"haas","name":"Haas","abbr":"HAS","color":"#B6BABD","strategy":"tyre_banker","carPace":75,"reliability":76,"pitSpeed":80,"tyreLife":71,"cornering":10,"topSpeed":11,"order":9,"powerUnit":"Ferrari"},{"id":"audi","name":"Audi","abbr":"AUD","color":"#B30000","strategy":"one_stop","carPace":71,"reliability":72,"pitSpeed":78,"tyreLife":66,"cornering":9,"topSpeed":10,"order":10,"powerUnit":"Audi"},{"id":"cadillac","name":"Cadillac","abbr":"CAD","color":"#9B9B9B","strategy":"fuel_save","carPace":67,"reliability":70,"pitSpeed":76,"tyreLife":62,"cornering":8,"topSpeed":9,"order":11,"powerUnit":"Ferrari"}],"people":[{"kind":"driver","id":"norris","name":"Lando Norris","abbr":"NOR","num":4,"teamId":"mclaren","flag":"🇬🇧","pace":94,"consistency":90,"wet":88,"overtaking":91,"defense":87,"experience":82,"mental":8,"style":"charger","rivals":["verstappen","leclerc"],"goodTracks":["britain","belgium","usa"],"badTracks":["monaco","singapore","hungary"]},{"kind":"driver","id":"piastri","name":"Oscar Piastri","abbr":"PIA","num":81,"teamId":"mclaren","flag":"🇦🇺","pace":91,"consistency":88,"wet":85,"overtaking":87,"defense":84,"experience":76,"mental":8,"style":"technical","rivals":["norris","russell"],"goodTracks":["australia","japan","miami"],"badTracks":["monaco","canada","azerbaijan"]},{"kind":"driver","id":"russell","name":"George Russell","abbr":"RUS","num":63,"teamId":"mercedes","flag":"🇬🇧","pace":90,"consistency":89,"wet":87,"overtaking":85,"defense":86,"experience":78,"mental":8,"style":"technical","rivals":["antonelli","norris"],"goodTracks":["britain","belgium","brazil"],"badTracks":["monaco","azerbaijan","lasvegas"]},{"kind":"driver","id":"antonelli","name":"Kimi Antonelli","abbr":"ANT","num":12,"teamId":"mercedes","flag":"🇮🇹","pace":86,"consistency":82,"wet":80,"overtaking":83,"defense":79,"experience":60,"mental":6,"style":"qualifier","rivals":["russell","hadjar"],"goodTracks":["italy","china","bahrain"],"badTracks":["monaco","singapore","canada"]},{"kind":"driver","id":"verstappen","name":"Max Verstappen","abbr":"VER","num":1,"teamId":"redbull","flag":"🇳🇱","pace":97,"consistency":95,"wet":96,"overtaking":96,"defense":94,"experience":92,"mental":9,"style":"aggressive","rivals":["norris","leclerc"],"goodTracks":["japan","belgium","brazil"],"badTracks":["singapore","monaco","hungary"]},{"kind":"driver","id":"hadjar","name":"Isack Hadjar","abbr":"HAD","num":6,"teamId":"redbull","flag":"🇫🇷","pace":84,"consistency":80,"wet":78,"overtaking":81,"defense":78,"experience":58,"mental":6,"style":"aggressive","rivals":["lawson","antonelli"],"goodTracks":["bahrain","spain","austria"],"badTracks":["monaco","singapore","lasvegas"]},{"kind":"driver","id":"leclerc","name":"Charles Leclerc","abbr":"LEC","num":16,"teamId":"ferrari","flag":"🇲🇨","pace":92,"consistency":87,"wet":88,"overtaking":89,"defense":86,"experience":82,"mental":7,"style":"qualifier","rivals":["hamilton","verstappen"],"goodTracks":["monaco","azerbaijan","italy"],"badTracks":["hungary","brazil","japan"]},{"kind":"driver","id":"hamilton","name":"Lewis Hamilton","abbr":"HAM","num":44,"teamId":"ferrari","flag":"🇬🇧","pace":88,"consistency":86,"wet":90,"overtaking":88,"defense":88,"experience":99,"mental":9,"style":"smooth","rivals":["leclerc","alonso"],"goodTracks":["britain","hungary","spain"],"badTracks":["azerbaijan","lasvegas","qatar"]},{"kind":"driver","id":"sainz","name":"Carlos Sainz","abbr":"SAI","num":55,"teamId":"williams","flag":"🇪🇸","pace":87,"consistency":88,"wet":85,"overtaking":84,"defense":85,"experience":86,"mental":8,"style":"smooth","rivals":["albon","leclerc"],"goodTracks":["singapore","spain","australia"],"badTracks":["hungary","brazil","abudhabi"]},{"kind":"driver","id":"albon","name":"Alex Albon","abbr":"ALB","num":23,"teamId":"williams","flag":"🇹🇭","pace":82,"consistency":83,"wet":80,"overtaking":80,"defense":82,"experience":74,"mental":7,"style":"defender","rivals":["sainz"],"goodTracks":["miami","usa","australia"],"badTracks":["monaco","singapore","brazil"]},{"kind":"driver","id":"lawson","name":"Liam Lawson","abbr":"LAW","num":30,"teamId":"racingbulls","flag":"🇳🇿","pace":80,"consistency":78,"wet":77,"overtaking":79,"defense":76,"experience":66,"mental":7,"style":"technical","rivals":["hadjar","lindblad"],"goodTracks":["japan","china","bahrain"],"badTracks":["monaco","singapore","austria"]},{"kind":"driver","id":"lindblad","name":"Arvid Lindblad","abbr":"LIN","num":7,"teamId":"racingbulls","flag":"🇬🇧","pace":74,"consistency":72,"wet":70,"overtaking":73,"defense":70,"experience":40,"mental":5,"style":"qualifier","rivals":["lawson"],"goodTracks":["britain","austria","bahrain"],"badTracks":["monaco","singapore","italy"]},{"kind":"driver","id":"alonso","name":"Fernando Alonso","abbr":"ALO","num":14,"teamId":"astonmartin","flag":"🇪🇸","pace":88,"consistency":90,"wet":92,"overtaking":89,"defense":91,"experience":99,"mental":10,"style":"strategist","rivals":["hamilton","verstappen"],"goodTracks":["monaco","hungary","spain"],"badTracks":["azerbaijan","lasvegas","canada"]},{"kind":"driver","id":"stroll","name":"Lance Stroll","abbr":"STR","num":18,"teamId":"astonmartin","flag":"🇨🇦","pace":72,"consistency":70,"wet":73,"overtaking":68,"defense":72,"experience":72,"mental":6,"style":"defender","rivals":["alonso"],"goodTracks":["azerbaijan","bahrain","saudi"],"badTracks":["monaco","hungary","brazil"]},{"kind":"driver","id":"bearman","name":"Oliver Bearman","abbr":"BEA","num":87,"teamId":"haas","flag":"🇬🇧","pace":78,"consistency":76,"wet":74,"overtaking":76,"defense":74,"experience":58,"mental":7,"style":"aggressive","rivals":["ocon"],"goodTracks":["italy","britain","miami"],"badTracks":["monaco","singapore","japan"]},{"kind":"driver","id":"camara","name":"Rafael Camara","abbr":"CAM","num":null,"teamId":"haas","flag":"🇧🇷","pace":75,"consistency":73,"wet":72,"overtaking":74,"defense":71,"experience":35,"mental":6,"style":"charger","rivals":["bearman"],"goodTracks":["brazil"],"badTracks":[]},{"kind":"driver","id":"hulkenberg","name":"Nico Hülkenberg","abbr":"HUL","num":27,"teamId":"audi","flag":"🇩🇪","pace":80,"consistency":82,"wet":78,"overtaking":77,"defense":80,"experience":90,"mental":8,"style":"ironman","rivals":["bortoleto"],"goodTracks":["austria","spain","brazil"],"badTracks":["monaco","singapore","italy"]},{"kind":"driver","id":"bortoleto","name":"Gabriel Bortoleto","abbr":"BOR","num":5,"teamId":"audi","flag":"🇧🇷","pace":76,"consistency":74,"wet":73,"overtaking":75,"defense":72,"experience":52,"mental":6,"style":"charger","rivals":["hulkenberg"],"goodTracks":["brazil","spain","usa"],"badTracks":["monaco","singapore","azerbaijan"]},{"kind":"driver","id":"gasly","name":"Pierre Gasly","abbr":"GAS","num":10,"teamId":"alpine","flag":"🇫🇷","pace":79,"consistency":78,"wet":77,"overtaking":78,"defense":77,"experience":80,"mental":7,"style":"charger","rivals":["colapinto","ocon"],"goodTracks":["italy","bahrain","spain"],"badTracks":["monaco","singapore","hungary"]},{"kind":"driver","id":"colapinto","name":"Franco Colapinto","abbr":"COL","num":43,"teamId":"alpine","flag":"🇦🇷","pace":76,"consistency":74,"wet":74,"overtaking":75,"defense":73,"experience":55,"mental":7,"style":"aggressive","rivals":["gasly"],"goodTracks":["lasvegas","brazil","miami"],"badTracks":["monaco","singapore","japan"]},{"kind":"driver","id":"perez","name":"Sergio Pérez","abbr":"PER","num":11,"teamId":"cadillac","flag":"🇲🇽","pace":78,"consistency":77,"wet":76,"overtaking":76,"defense":78,"experience":88,"mental":6,"style":"strategist","rivals":["bottas"],"goodTracks":["azerbaijan","saudi","singapore"],"badTracks":["monaco","hungary","brazil"]},{"kind":"driver","id":"bottas","name":"Valtteri Bottas","abbr":"BOT","num":77,"teamId":"cadillac","flag":"🇫🇮","pace":74,"consistency":75,"wet":74,"overtaking":72,"defense":74,"experience":86,"mental":7,"style":"ironman","rivals":["perez"],"goodTracks":["austria","japan","spain"],"badTracks":["monaco","azerbaijan","lasvegas"]},{"id":"tp-mclaren","kind":"principal","name":"Andrea Stella","teamId":"mclaren"},{"id":"tp-ferrari","kind":"principal","name":"Fred Vasseur","teamId":"ferrari"},{"id":"tp-redbull","kind":"principal","name":"Laurent Mekies","teamId":"redbull"},{"id":"tp-mercedes","kind":"principal","name":"Toto Wolff","teamId":"mercedes"},{"id":"tp-williams","kind":"principal","name":"James Vowles","teamId":"williams"},{"id":"tp-racingbulls","kind":"principal","name":"Alan Permane","teamId":"racingbulls"},{"id":"tp-astonmartin","kind":"principal","name":"Adrian Newey","teamId":"astonmartin"},{"id":"tp-alpine","kind":"principal","name":"Steve Nielsen","teamId":"alpine"},{"id":"tp-haas","kind":"principal","name":"Ayao Komatsu","teamId":"haas"},{"id":"tp-audi","kind":"principal","name":"Mattia Binotto","teamId":"audi"},{"id":"tp-cadillac","kind":"principal","name":"Marcin Budkowski","teamId":"cadillac"}],"tracks":[{"round":1,"id":"australia","name":"Australian GP","circuit":"Albert Park","flag":"🇦🇺","laps":58,"od":45,"td":60,"wr":30,"type":"mixed","hasSprint":false,"drs":4,"alt":10,"temp":21,"abrasive":4,"street":false},{"round":2,"id":"china","name":"Chinese GP","circuit":"Shanghai Int'l","flag":"🇨🇳","laps":56,"od":40,"td":65,"wr":40,"type":"mixed","hasSprint":true,"drs":2,"alt":5,"temp":16,"abrasive":3,"street":false},{"round":3,"id":"japan","name":"Japanese GP","circuit":"Suzuka","flag":"🇯🇵","laps":53,"od":60,"td":55,"wr":50,"type":"high-speed","hasSprint":false,"drs":2,"alt":40,"temp":15,"abrasive":4,"street":false},{"round":4,"id":"bahrain","name":"Bahrain GP","circuit":"Bahrain Int'l","flag":"🇧🇭","laps":57,"od":40,"td":68,"wr":5,"type":"technical","hasSprint":false,"drs":3,"alt":7,"temp":30,"abrasive":7,"street":false},{"round":5,"id":"saudi","name":"Saudi Arabian GP","circuit":"Jeddah Corniche","flag":"🇸🇦","laps":50,"od":30,"td":58,"wr":5,"type":"street","hasSprint":false,"drs":3,"alt":10,"temp":28,"abrasive":2,"street":true},{"round":6,"id":"miami","name":"Miami GP","circuit":"Miami Int'l","flag":"🇺🇸","laps":57,"od":50,"td":70,"wr":35,"type":"street","hasSprint":true,"drs":3,"alt":2,"temp":28,"abrasive":3,"street":true},{"round":7,"id":"spain","name":"Spanish GP","circuit":"Circuit de Barcelona","flag":"🇪🇸","laps":66,"od":55,"td":72,"wr":25,"type":"high-downforce","hasSprint":false,"drs":2,"alt":110,"temp":24,"abrasive":4,"street":false},{"round":8,"id":"monaco","name":"Monaco GP","circuit":"Circuit de Monaco","flag":"🇲🇨","laps":78,"od":88,"td":40,"wr":30,"type":"street","hasSprint":false,"drs":1,"alt":15,"temp":20,"abrasive":2,"street":true},{"round":9,"id":"canada","name":"Canadian GP","circuit":"Gilles Villeneuve","flag":"🇨🇦","laps":70,"od":25,"td":68,"wr":45,"type":"street","hasSprint":false,"drs":2,"alt":12,"temp":22,"abrasive":2,"street":true},{"round":10,"id":"austria","name":"Austrian GP","circuit":"Red Bull Ring","flag":"🇦🇹","laps":71,"od":35,"td":55,"wr":40,"type":"high-speed","hasSprint":true,"drs":3,"alt":680,"temp":22,"abrasive":3,"street":false},{"round":11,"id":"britain","name":"British GP","circuit":"Silverstone","flag":"🇬🇧","laps":52,"od":40,"td":70,"wr":60,"type":"high-speed","hasSprint":false,"drs":2,"alt":126,"temp":18,"abrasive":4,"street":false},{"round":12,"id":"hungary","name":"Hungarian GP","circuit":"Hungaroring","flag":"🇭🇺","laps":70,"od":65,"td":55,"wr":40,"type":"technical","hasSprint":false,"drs":2,"alt":260,"temp":30,"abrasive":3,"street":false},{"round":13,"id":"belgium","name":"Belgian GP","circuit":"Spa-Francorchamps","flag":"🇧🇪","laps":44,"od":30,"td":60,"wr":70,"type":"high-speed","hasSprint":false,"drs":2,"alt":435,"temp":17,"abrasive":4,"street":false},{"round":14,"id":"netherlands","name":"Dutch GP","circuit":"Zandvoort","flag":"🇳🇱","laps":72,"od":65,"td":65,"wr":45,"type":"technical","hasSprint":false,"drs":2,"alt":5,"temp":18,"abrasive":5,"street":false},{"round":15,"id":"italy","name":"Italian GP","circuit":"Monza","flag":"🇮🇹","laps":53,"od":20,"td":45,"wr":30,"type":"low-downforce","hasSprint":false,"drs":2,"alt":162,"temp":24,"abrasive":3,"street":false},{"round":16,"id":"azerbaijan","name":"Azerbaijan GP","circuit":"Baku City Circuit","flag":"🇦🇿","laps":51,"od":22,"td":55,"wr":15,"type":"street","hasSprint":false,"drs":2,"alt":28,"temp":25,"abrasive":2,"street":true},{"round":17,"id":"singapore","name":"Singapore GP","circuit":"Marina Bay","flag":"🇸🇬","laps":61,"od":72,"td":70,"wr":50,"type":"street","hasSprint":false,"drs":3,"alt":15,"temp":32,"abrasive":3,"street":true},{"round":18,"id":"usa","name":"United States GP","circuit":"Circuit of the Americas","flag":"🇺🇸","laps":56,"od":40,"td":65,"wr":35,"type":"mixed","hasSprint":true,"drs":2,"alt":300,"temp":28,"abrasive":5,"street":false},{"round":19,"id":"mexico","name":"Mexican GP","circuit":"Autodromo HR","flag":"🇲🇽","laps":71,"od":45,"td":50,"wr":25,"type":"technical","hasSprint":false,"drs":3,"alt":2285,"temp":21,"abrasive":3,"street":false},{"round":20,"id":"brazil","name":"Brazilian GP","circuit":"Interlagos","flag":"🇧🇷","laps":71,"od":30,"td":60,"wr":65,"type":"mixed","hasSprint":true,"drs":2,"alt":785,"temp":26,"abrasive":4,"street":false},{"round":21,"id":"lasvegas","name":"Las Vegas GP","circuit":"Las Vegas Strip","flag":"🇺🇸","laps":50,"od":35,"td":55,"wr":10,"type":"street","hasSprint":false,"drs":3,"alt":640,"temp":12,"abrasive":2,"street":true},{"round":22,"id":"qatar","name":"Qatar GP","circuit":"Lusail Circuit","flag":"🇶🇦","laps":57,"od":45,"td":75,"wr":5,"type":"technical","hasSprint":true,"drs":2,"alt":15,"temp":30,"abrasive":8,"street":false},{"round":23,"id":"abudhabi","name":"Abu Dhabi GP","circuit":"Yas Marina","flag":"🇦🇪","laps":58,"od":45,"td":50,"wr":5,"type":"mixed","hasSprint":false,"drs":2,"alt":3,"temp":28,"abrasive":3,"street":false}]};
const F1_ROLE = { principal: 'Team principal', driver: 'Driver', engineer: 'Race engineer' };
/* A player's new driver starts here; Race Control tunes it on the ratings screen. */
const F1_ROOKIE = { pace: 80, consistency: 78, wet: 76, overtaking: 78, defense: 76, experience: 40, mental: 6, style: 'technical', goodTracks: [], badTracks: [], rivals: [] };
const F1_STYLES = [['charger', 'Charger'], ['aggressive', 'Aggressive'], ['qualifier', 'Qualifier'], ['technical', 'Technical'], ['smooth', 'Smooth'], ['defender', 'Defender'], ['strategist', 'Strategist'], ['ironman', 'Ironman']];
const F1_RATINGS = [['pace', 'Pace'], ['consistency', 'Consistency'], ['wet', 'Wet weather'], ['overtaking', 'Overtaking'], ['defense', 'Defence'], ['experience', 'Experience']];
const F1_WEATHER = [['track', 'The track’s usual rain risk'], ['dry', 'Dry'], ['mid', 'Rain mid-race'], ['wet', 'Wet start, drying']];

const F1 = {
  teams: () => list('f1_teams').sort((a, b) => (a.order || 0) - (b.order || 0)),
  team: id => get('f1_teams', id) || { id, name: id, color: '#888888' },
  person: id => get('f1_people', id),
  seats: teamId => list('f1_seats').filter(s => !teamId || s.teamId === teamId).sort((a, b) => (a.order || 0) - (b.order || 0)),
  tracks: () => list('f1_tracks').sort((a, b) => (a.round || 0) - (b.round || 0)),
  track: id => get('f1_tracks', id),
  weekends: () => list('f1_weekends').sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))),
  live: () => list('f1_weekends').find(w => w.status !== 'finished') || null
};
const f1PcId = charId => 'pc-' + charId;
/* Typed fields store their value without redrawing the page. The app redraws on every
   change event, and a redraw between pressing and releasing a button swallows the click. */
document.addEventListener('input', e => {
  const el = e.target, path = el && el.dataset && el.dataset.f1bind; if (!path) return;
  setPath(path, el.dataset.type === 'number' ? (el.value === '' ? null : Number(el.value)) : el.value);
});
const f1Colour = teamId => (F1.team(teamId).color || '#888888');

/* Who sits in a seat now: a character overrides the real default. */
function f1Occupant(seat) {
  const real = seat.defaultPersonId ? F1.person(seat.defaultPersonId) : null;
  if (seat.holderCharId) {
    const person = F1.person(f1PcId(seat.holderCharId));
    return { player: true, charId: seat.holderCharId, person, name: (person && person.name) || seat.holderName || 'A character', real };
  }
  return { player: false, person: real, name: real ? real.name : (seat.role === 'engineer' ? 'Team engineer' : 'Vacant'), real };
}
const f1MySeats = () => S.charId ? F1.seats().filter(s => s.holderCharId === S.charId) : [];
function f1Code(name) { const parts = String(name || '').trim().split(/\s+/); return (parts[parts.length - 1] || 'DRV').normalize('NFD').replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase().padEnd(3, 'X'); }

/* ---------------------------------------------------------------- loading today's grid */
async function f1PutAll(rows) {
  for (let i = 0; i < rows.length; i += 10) await Promise.all(rows.slice(i, i + 10).map(([c, id, d]) => Data.put(c, id, d)));
}
ACTIONS['f1-load'] = () => askConfirm('Load today’s grid: 11 teams, their drivers and team principals, and 23 circuits? Teams, ratings and circuits go back to today’s values; seats players hold are kept.', 'Load the grid', async () => {
  await run(async () => {
    const rows = [];
    F1_DEFAULTS.teams.forEach(t => rows.push(['f1_teams', t.id, Object.assign({}, t)]));
    F1_DEFAULTS.people.forEach(p => rows.push(['f1_people', p.id, Object.assign({}, p)]));
    F1_DEFAULTS.tracks.forEach(t => rows.push(['f1_tracks', t.id, Object.assign({}, t)]));
    F1_DEFAULTS.teams.forEach((t, ti) => {
      const drivers = F1_DEFAULTS.people.filter(p => p.kind === 'driver' && p.teamId === t.id);
      const seat = (key, role, car, order, def) => {
        const id = `${t.id}-${key}`, old = (S.store.f1_seats || {})[id] || {};
        rows.push(['f1_seats', id, { teamId: t.id, role, car, order: ti * 10 + order, defaultPersonId: def || null,
          holderCharId: old.holderCharId || null, holderName: old.holderName || null, holderSince: old.holderSince || null, open: id in (S.store.f1_seats || {}) ? !!old.open : true }]);
      };
      seat('tp', 'principal', null, 0, 'tp-' + t.id);
      seat('d1', 'driver', 1, 1, drivers[0] && drivers[0].id); seat('e1', 'engineer', 1, 2, null);
      seat('d2', 'driver', 2, 3, drivers[1] && drivers[1].id); seat('e2', 'engineer', 2, 4, null);
    });
    await f1PutAll(rows);
    await Data.audit('f1.grid-load', 'Loaded today’s grid');
  }, 'Today’s grid is loaded.');
});

/* ---------------------------------------------------------------- seats */
/* Put a character into a seat (or hand it back with charId = null). One seat per character. */
async function f1Assign(seatId, charId) {
  const seat = get('f1_seats', seatId); if (!seat) throw { message: 'That seat no longer exists' };
  const team = F1.team(seat.teamId), roleName = F1_ROLE[seat.role] || seat.role;
  const empty = { holderCharId: null, holderName: null, holderSince: null, open: true };   /* a seat handed back is open again */
  if (!charId) {
    await Data.put('f1_seats', seatId, Object.assign(clone(S.store.f1_seats[seatId]), empty));
    await Data.audit('seat.release', `${roleName}, ${team.name}: seat handed back to ${(f1Occupant(Object.assign({}, seat, empty)).name)}`);
    return;
  }
  const c = get('characters', charId); if (!c) throw { message: 'That character no longer exists' };
  /* One seat per series: hand back the character's other seat in this seat's series, whichever series Race Control is looking at. */
  const seriesOfSeat = (get('f1_teams', seat.teamId) || {}).seriesId || 'f1';
  for (const other of list('f1_seats').filter(s => s.holderCharId === charId && s.id !== seatId && ((get('f1_teams', s.teamId) || {}).seriesId || 'f1') === seriesOfSeat))
    await Data.put('f1_seats', other.id, Object.assign(clone(S.store.f1_seats[other.id]), empty));
  const pid = f1PcId(charId), cur = F1.person(pid);
  const person = Object.assign({}, F1_ROOKIE, cur ? clone(S.store.f1_people[pid]) : {}, {
    kind: seat.role, charId, teamId: seat.teamId, name: c.name,
    abbr: (cur && cur.abbr) || c.code || f1Code(c.name), flag: (cur && cur.flag) || '', num: (cur && cur.num) || c.number || null });
  await Data.put('f1_people', pid, person);
  await Data.put('f1_seats', seatId, Object.assign(clone(S.store.f1_seats[seatId]), { holderCharId: charId, holderName: c.name, holderSince: nowIso(), open: false }));
  for (const a of list('f1_applications').filter(x => x.seatId === seatId && x.status === 'pending' && x.charId !== charId))
    await Data.put('f1_applications', a.id, Object.assign(clone(S.store.f1_applications[a.id]), { status: 'declined', decidedAt: nowIso(), reply: 'The seat went to someone else.' }));
  await Data.audit('seat.take', `${c.name} takes the ${roleName.toLowerCase()} seat at ${team.name}`);
}
CHANGES['f1-seat'] = (v, ds) => run(() => f1Assign(ds.id, v || null), v ? 'Seat filled. The character now replaces the real default.' : 'Seat handed back to the real default.');
ACTIONS['seat-open'] = d => { const s = get('f1_seats', d.id); if (!s) return;
  run(async () => { await Data.put('f1_seats', s.id, Object.assign(clone(S.store.f1_seats[s.id]), { open: !s.open })); }, s.open ? 'Seat closed to applications.' : 'Seat open for applications.'); };

/* ---------------------------------------------------------------- applying for a seat */
const seatTitle = s => s.role === 'principal' ? 'Team principal' : s.role === 'driver' ? `Driver, car ${s.car}` : `Race engineer, car ${s.car}`;
const ROLE_FOR_SEAT = { principal: ['principal'], driver: ['driver'], engineer: ['engineer'] };
ACTIONS['seat-apply'] = d => {
  const c = currentChar(); if (!c) { toast('Create a character first, on Your characters.', true); return; }
  if (!charApproved(c)) { toast(`Race Control needs to approve ${c.name}’s application before they can apply for a seat.`, true); return; }
  S.ui.form.app = { seatId: d.id, note: '' }; openDrawer('apply');
};
DRAWERS.apply = function () {
  const f = S.ui.form.app || {}, s = get('f1_seats', f.seatId), c = currentChar(); if (!s || !c) return '';
  const t = F1.team(s.teamId), o = f1Occupant(s);
  return `<header><div><h2>Apply for ${esc(seatTitle(s).toLowerCase())} at ${esc(t.name)}</h2><p>${esc(c.name)} applies. ${o.real ? `If Race Control says yes, ${esc(c.name)} takes the seat in place of ${esc(o.real.name)}.` : ''}</p></div>
    <button class="btn ghost" data-act="close-drawer">Close</button></header>
    <div class="body"><label class="field">Why ${esc(c.name.split(' ')[0])}, and why this team?<textarea id="app-note" rows="7" data-bind="ui/form/app/note" placeholder="Their pitch to the team: results, ambitions, what they bring"></textarea></label>
    <div class="btn-row"><button class="btn primary" data-act="seat-apply-send">Send application</button></div></div>`;
};
ACTIONS['seat-apply-send'] = () => {
  const f = S.ui.form.app || {}, c = currentChar(), s = get('f1_seats', f.seatId); if (!c || !s) return;
  if (list('f1_applications').some(a => a.charId === c.id && a.seatId === s.id && a.status === 'pending')) { toast(`${c.name} has already applied for this seat.`, true); return; }
  run(async () => {
    await Data.put('f1_applications', newId('app'), { userId: asOwner(), charId: c.id, charName: c.name, seatId: s.id, teamId: s.teamId, role: s.role, note: String(f.note || '').trim(), status: 'pending', createdAt: nowIso() });
    closeDrawer();
  }, 'Application sent to Race Control.');
};
ACTIONS['app-withdraw'] = d => run(async () => { await Data.remove('f1_applications', d.id); }, 'Application withdrawn.');
ACTIONS['app-decide'] = d => {
  const a = get('f1_applications', d.id); if (!a) return;
  if (d.ok === '1') askConfirm(`Give ${a.charName} the seat? Whoever holds it now hands it back.`, 'Give them the seat', () => run(async () => {
    await f1Assign(a.seatId, a.charId);
    await Data.put('f1_applications', a.id, Object.assign(clone(S.store.f1_applications[a.id]), { status: 'approved', decidedAt: nowIso() }));
  }, `${a.charName} has the seat.`));
  else run(async () => { await Data.put('f1_applications', a.id, Object.assign(clone(S.store.f1_applications[a.id]), { status: 'declined', decidedAt: nowIso() })); }, 'Application declined.');
};

/* ---------------------------------------------------------------- ratings */
ACTIONS['f1-person'] = d => {
  const p = F1.person(d.id); if (!p) return;
  S.ui.form.f1p = Object.assign({}, F1_ROOKIE, clone(S.store.f1_people[d.id]), { id: d.id });
  openDrawer('f1-person', { id: d.id });
};
DRAWERS['f1-person'] = function (d) {
  const f = S.ui.form.f1p || {}, num = (k, label, min, max) => `<label class="field">${label}<input id="f1p-${k}" type="number" min="${min}" max="${max}" step="1" data-bind="ui/form/f1p/${k}" data-type="number" value="${esc(f[k] == null ? '' : f[k])}"></label>`;
  return `<header><div><h2>${esc(f.name || '')}</h2><p>${f.charId ? 'A player’s character. ' : 'A real driver. '}Ratings run from 1 to 99; mental strength from 1 to 10.</p></div>
      <button class="btn ghost" data-act="close-drawer">Close</button></header>
    <div class="body">
      <div class="f1-ratings">
        <label class="field">Name<input id="f1p-name" type="text" data-bind="ui/form/f1p/name" value="${esc(f.name || '')}"></label>
        <label class="field">Three-letter code<input id="f1p-abbr" type="text" maxlength="3" data-bind="ui/form/f1p/abbr" value="${esc(f.abbr || '')}"></label>
        ${num('num', 'Car number', 1, 99)}
        <label class="field">Driving style<select id="f1p-style" data-bind="ui/form/f1p/style">${F1_STYLES.map(([k, l]) => `<option value="${k}" ${f.style === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        ${F1_RATINGS.map(([k, l]) => num(k, l, 1, 99)).join('')}
        ${num('mental', 'Mental strength', 1, 10)}
      </div>
      <p class="muted small" style="margin-top:12px">Overtaking and defence decide wheel-to-wheel fights; experience and mental strength cut mistakes under pressure; the style nudges tyre wear, set-up and aggression.</p>
      <div class="btn-row" style="margin-top:12px"><button class="btn primary" data-act="f1-person-save">Save ratings</button></div>
    </div>`;
};
ACTIONS['f1-person-save'] = () => {
  const f = clone(S.ui.form.f1p || {}); if (!f.id) return;
  const id = f.id; delete f.id;
  const bad = F1_RATINGS.map(r => r[0]).find(k => !(f[k] >= 1 && f[k] <= 99));
  if (bad) { toast(`${F1_RATINGS.find(r => r[0] === bad)[1]} must be between 1 and 99.`, true); return; }
  if (!(f.mental >= 1 && f.mental <= 10)) { toast('Mental strength must be between 1 and 10.', true); return; }
  f.abbr = String(f.abbr || f1Code(f.name)).toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3);
  run(async () => { await Data.put('f1_people', id, f); await Data.audit('f1.ratings', `Ratings updated for ${f.name}`); closeDrawer(); }, 'Ratings saved.');
};

/* ---------------------------------------------------------------- The Grid */
function f1OccupantHtml(seat) {
  const o = f1Occupant(seat), you = S.charId && seat.holderCharId === S.charId;
  const p = o.person, driver = seat.role === 'driver';
  let sub = '';
  if (o.player && o.real) sub = `<span class="muted small">In place of ${esc(o.real.name)}</span>`;
  else if (driver && p) sub = `<span class="muted small">${p.num ? '#' + esc(p.num) + ' ' : ''}${esc(p.abbr || '')}, pace ${esc(p.pace)}</span>`;
  const chips = (o.player ? '<span class="tag player">Player</span>' : (p ? '<span class="tag">Real</span>' : '')) + (you ? ' <span class="tag you">You</span>' : '');
  return `<div class="f1-occ"><b>${p && p.flag ? esc(p.flag) + ' ' : ''}${p ? careerLink(p.id, o.name) : esc(o.name)}</b> ${chips}${sub}</div>`;
}
function f1SeatControls(seat) {
  const c = currentChar(), mineOpen = list('f1_applications').find(a => c && a.charId === c.id && a.seatId === seat.id && a.status === 'pending');
  if (!S.isGm) {
    if (!seat.open || seat.holderCharId === S.charId) return '';
    if (mineOpen) return `<div class="ctl"><span class="tag">Applied</span><button class="btn small" data-act="app-withdraw" data-id="${esc(mineOpen.id)}">Withdraw</button></div>`;
    return `<div class="ctl"><span class="tag open">Open seat</span>${c ? `<button class="btn small primary" data-act="seat-apply" data-id="${esc(seat.id)}">Apply as ${esc(c.name.split(' ')[0])}</button>` : ''}</div>`;
  }
  const o = f1Occupant(seat), held = new Map(F1.seats().filter(s => s.holderCharId).map(s => [s.holderCharId, s]));
  const chars = list('characters').filter(x => !x.retired).sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const def = o.real ? `${o.real.name} (real)` : 'No player';
  const opts = chars.map(x => { const h = held.get(x.id), note = h && h.id !== seat.id ? `, now ${F1_ROLE[h.role].toLowerCase()} at ${F1.team(h.teamId).name}` : '';
    return `<option value="${esc(x.id)}" ${seat.holderCharId === x.id ? 'selected' : ''}>${esc(x.name + ' (' + charRoleName(x.role).toLowerCase() + note + ')')}</option>`; }).join('');
  const apps = list('f1_applications').filter(a => a.seatId === seat.id && a.status === 'pending').length;
  const ratings = seat.role === 'driver' && o.person ? `<button class="btn small" data-act="f1-person" data-id="${esc(o.person.id)}">Ratings</button>` : '';
  return `<div class="ctl"><label class="sr-only" for="f1s-${esc(seat.id)}">Who sits in the ${esc(F1_ROLE[seat.role].toLowerCase())} seat at ${esc(F1.team(seat.teamId).name)}</label>
    <select id="f1s-${esc(seat.id)}" data-change="f1-seat" data-id="${esc(seat.id)}"><option value="">${esc(def)}</option>${opts}</select>${ratings}
    <button class="btn small ${seat.open ? 'on' : ''}" data-act="seat-open" data-id="${esc(seat.id)}" aria-pressed="${!!seat.open}">${seat.open ? 'Open to applications' : 'Open it'}</button>
    ${apps ? `<button class="btn small" data-act="nav" data-route="control">${plural(apps, 'application')}</button>` : ''}</div>`;
}
function f1TeamCard(t) {
  const arch = FormulaRacingAdapter.ARCHETYPES[t.strategy] || FormulaRacingAdapter.ARCHETYPES.reactive;
  return `<section class="card f1-team" style="--team:${esc(t.color)}" aria-label="${esc(t.name)}">
    ${(b => b.car ? `<img class="grid-car" src="${esc(b.car)}" alt="${esc(t.name)} car">` : '')(teamBrand(t.id))}
    <header><h2>${(b => b.logo ? `<img class="team-logo" src="${esc(b.logo)}" alt="">` : '')(teamBrand(t.id))}${esc(t.name)}</h2><span class="meta">${esc(engineLabel(t.id))}. AI strategist: ${esc(arch.label.toLowerCase())}.</span>
      ${S.isGm ? `<button class="btn small ghost" data-act="car-edit" data-id="${esc(t.id)}">Car</button>` : ''}</header>
    <ul class="f1-seatlist">${F1.seats(t.id).map(s => `<li><span class="role">${esc(seatTitle(s))}</span>${f1OccupantHtml(s)}${f1SeatControls(s)}</li>`).join('')}</ul>
  </section>`;
}
route('grid', 'The Grid', function () {
  const teams = F1.teams();
  const head = `<div class="page-head"><div><h1>The Grid</h1>
    <p>Today’s real grid is the starting point. When a player’s character takes a seat, they race in place of the real driver, or run the team in place of the real team principal, until the seat is handed back.</p></div></div>`;
  if (!teams.length && curSeriesId() !== 'f1') return head + `<div class="card empty-card"><h2>${esc(curSeries().name)} has no teams yet</h2><p>${S.isGm ? 'Set it up on the Series page.' : 'Race Control hasn’t set it up yet.'}</p></div>`;
  if (!teams.length) return head + `<div class="card empty-card"><h2>No grid yet</h2>${S.isGm ? `<p>Load today’s grid to start: 11 teams with their real drivers and team principals, plus 23 circuits. Then put characters into seats, or open seats for players to apply.</p>
    <button class="btn primary" data-act="f1-load">Load today’s grid</button>` : '<p>Race Control hasn’t set up the grid yet.</p>'}</div>`;
  const all = F1.seats(), mine = f1MySeats(), open = all.filter(s => s.open).length;
  const mineHtml = mine.length ? `<div class="card your-seat" style="--team:${esc(F1.team(mine[0].teamId).color)}"><h2>Your seat</h2>${mine.map(s => { const t = F1.team(s.teamId), o = f1Occupant(s);
      return `<p><b>${esc(seatTitle(s))}, ${esc(t.name)}</b>${o.real ? `, in place of ${esc(o.real.name)}` : ''}.</p>`; }).join('')}
      <p class="muted">Your pit wall is on Race Weekend whenever a weekend is open.</p></div>` : '';
  return head + mineHtml + `<div class="metrics"><div class="metric"><b>${teams.length}</b><span>Teams</span></div>
      <div class="metric"><b>${all.filter(s => s.holderCharId).length}</b><span>Seats held by players</span></div>
      <div class="metric"><b>${all.filter(s => s.role === 'driver' && !s.holderCharId).length}</b><span>Real drivers racing</span></div>
      <div class="metric"><b>${open}</b><span>Seats open to applications</span></div></div>
    ${!S.isGm && open ? `<p class="lead">Seats marked <span class="tag open">Open seat</span> take applications. Apply as the character you’re playing.</p>` : ''}
    <div class="f1-teams">${teams.map(f1TeamCard).join('')}</div>
    ${S.isGm ? `<p class="muted" style="margin-top:16px">Pick a character in any seat to put them there; pick the real person to hand it back. Open a seat to let players apply. <button class="btn small" data-act="f1-load">Reload today’s grid</button></p>` : ''}`;
});


/* ---------------------------------------------------------------- race weekends: building the field */
function f1Entrants() {
  const out = [], used = new Set();
  F1.teams().forEach(t => F1.seats(t.id).filter(s => s.role === 'driver').forEach(s => {
    const o = f1Occupant(s), p = o.person; if (!p) return;
    const base = String(p.abbr || f1Code(p.name)).toUpperCase().slice(0, 3);
    let code = base, n = 2; while (used.has(code)) code = base.slice(0, 2) + n++;
    used.add(code);
    out.push({ id: code, seatId: s.id, car: s.car, teamId: t.id, personId: p.id, charId: s.holderCharId || null, name: p.name,
      v3: f1DevApply(Object.assign({}, F1_ROOKIE, p, { abbr: code, teamId: t.id }), s.holderCharId) });
  }));
  return out;
}
function f1Weather(w, track) {
  const L = track.laps, at = f => Math.max(2, Math.round(L * f));
  if (w.weatherMode === 'dry') return { start: 'dry' };
  if (w.weatherMode === 'mid') return { start: 'dry', changes: [{ lap: at(.35), to: 'damp' }, { lap: at(.41), to: 'wet' }, { lap: at(.55), to: 'damp' }, { lap: at(.63), to: 'dry' }] };
  if (w.weatherMode === 'wet') return { start: 'wet', qualifying: 'wet', changes: [{ lap: at(.18), to: 'damp' }, { lap: at(.34), to: 'dry' }] };
  const pct = raceSettings(w).rainPct;
  if (pct !== 'track' && pct != null) return { mode: 'variable', rainChance: Number(pct) / 100 };
  return FormulaRacingAdapter.weatherFor(track, 'variable');
}
/* The circuit and rules for this weekend, with Race Control's chances for safety cars and failures. */
function f1RaceSetup(w, track) {
  const st = raceSettings(w), circuit = FormulaRacingAdapter.toCircuit(track);
  circuit.sprintLaps = track.sprintLaps;
  const rules = Object.assign({}, F1_RULES, seriesRules(seriesDoc(wSeries(w))), { crashRate: RaceEngine.DEFAULTS.crashRate * st.scRate, failureRate: RaceEngine.DEFAULTS.failureRate * st.failRate });
  /* The season's engine era: lap times, power, battery and boost, fuel, tyres and reliability. */
  const out = engineRaceSetup(w, circuit, rules);
  /* Race incidents: Race Control's settings scale each family; the engine era makes failures likelier or rarer. */
  out.rules.incidents = { crashes: rateNum(st.scRate), failures: rateNum(st.failRate) * engineFormula(wSeries(w), wSeason(w)).fail, outside: rateNum(st.extRate) };
  out.rules.weatherEvents = w.weatherMode !== 'dry';
  return out;
}
function f1NextTrack() {
  const done = new Set(F1.weekends().filter(w => w.status === 'finished' && w.session === 'gp').map(w => w.trackId));
  return F1.tracks().find(t => !done.has(t.id)) || F1.tracks()[0];
}

/* ---------------------------------------------------------------- pit-wall calls and who may make them */
function f1CallAllowed(c, w) {
  const ent = (w.entrants || f1Entrants()).find(e => e.id === c.carId), team = c.teamId || (ent && ent.teamId);
  if (raceLocked(w) && RACE_CALLS.indexOf(c.type) !== -1) return false;
  const seats = F1.seats(team).filter(s => s.holderCharId && s.holderCharId === c.charId);
  if (!seats.length) return false;
  const tp = seats.some(s => s.role === 'principal');
  const own = role => !!ent && seats.some(s => s.role === role && s.car === ent.car);
  switch (c.type) {
    case 'order': return tp;
    case 'setup': return f1CanRun(w, ent, c.charId);
    case 'box': case 'mode': return tp || own('engineer') || own('driver');
    case 'refuseOrder': return own('driver');
    case 'strategy': return tp || own('engineer') || own('driver');
    case 'moment': return own('driver');
    default: return false;
  }
}
const f1Calls = w => list('f1_calls').filter(c => c.weekendId === w.id && (typeof callAllowed !== 'function' || callAllowed(c))).sort((a, b) => String(a.at).localeCompare(String(b.at)));
function f1CallText(c, w) {
  const ent = (w.entrants || f1Entrants()).find(e => e.id === c.carId), who = ent ? ent.id : F1.team(c.teamId).name;
  if (c.type === 'box') return `${who}: box for ${c.value === 'auto' ? 'the best tyre' : RaceEngine.COMPOUNDS[c.value].label.toLowerCase() + 's'}`;
  if (c.type === 'mode') return `${who}: ${RaceEngine.MODES[c.value].label.toLowerCase()} mode`;
  if (c.type === 'order') return `${who}: team order, ${c.value === 'none' ? 'free to race' : c.value === 'hold' ? 'hold positions' : 'swap the cars'}`;
  if (c.type === 'refuseOrder') return `${who}: refuses the team order`;
  if (c.type === 'moment') return `${who}: driver’s call made`;
  if (c.type === 'strategy') return `${who}: switch to ${PLAN_NAMES[Number(c.value) || 0]}`;
  if (c.type === 'setup') return `${who}: set-up locked in (${typeof c.value === 'object' ? dialText(c.value) : c.value})`;
  return who;
}
function f1SendCall(call) {
  const w = F1.live(); if (!w || !S.charId) return;
  const doc = Object.assign({ weekendId: w.id, userId: asOwner(), charId: S.charId, at: nowIso(), lap: (w.state && w.state.lap) || 0 }, call);
  if (raceLocked(w) && RACE_CALLS.indexOf(doc.type) !== -1) { toast('This is an official race: nothing can be changed once it starts. Your plans, triggers and race approach are running the car.', true); return; }
  if (!f1CallAllowed(doc, w)) { toast('Your seat doesn’t allow that call.', true); return; }
  /* A newer call of the same kind for the same car replaces the older one. */
  const old = f1Calls(w).filter(c => c.charId === S.charId && c.type === doc.type && c.carId === doc.carId && c.teamId === doc.teamId);
  run(async () => { for (const o of old) await Data.remove('f1_calls', o.id); await Data.put('f1_calls', newId('f1c'), doc); },
    doc.type === 'setup' ? 'Set-up sent to Race Control.' : 'Call sent. It applies from the next lap.');
}
ACTIONS['f1-call'] = d => f1SendCall({ type: d.type, carId: d.car || null, teamId: d.team || null, value: d.value || null });
ACTIONS['f1-call-setup'] = d => { const v = Number((S.ui.form.f1setup || {})[d.car] || 60); f1SendCall({ type: 'setup', carId: d.car, value: Math.max(20, Math.min(95, v)) }); };
ACTIONS['f1-call-withdraw'] = d => run(async () => { await Data.remove('f1_calls', d.id); }, 'Call withdrawn.');

/* ---------------------------------------------------------------- Race Control: running the weekend */
ACTIONS['f1-open'] = () => {
  const f = S.ui.form.f1w || {}, track = F1.track(f.trackId) || f1NextTrack();
  if (!track) { toast('Load the grid first.', true); return; }
  if (F1.live()) { toast('A weekend is already open. Finish or cancel it first.', true); return; }
  if (seasonClosed()) { toast('This season is catalogued. Start the next season on the Seasons page first.', true); return; }
  const session = f.session === 'test' ? 'test' : f.session === 'sprint' && track.hasSprint ? 'sprint' : 'gp', id = newId('f1w');
  const seed = Math.max(1, parseInt(f.seed, 10) || (1 + Math.floor(Math.random() * 999999)));
  run(async () => {
    await Data.put('f1_weekends', id, { seriesId: curSeriesId(), seasonId: curSeasonId(), trackId: track.id, round: track.round, session, seed, weatherMode: f.weatherMode || 'track', status: 'practice', createdAt: nowIso(),
      settings: { lock: f.lock !== false, scRate: rateNum(f.scRate), failRate: rateNum(f.failRate), extRate: rateNum(f.extRate), rainPct: f.rainPct || 'track', practice: f.practice || 'full' } });
    await Data.audit('f1.weekend-open', `${track.name}${session === 'sprint' ? ' sprint' : ''} opened`);
    S.ui.form.f1w = null; S.ui.f1view = null;
  }, 'Weekend open. Teams can send their set-ups.');
};
ACTIONS['f1-cancel'] = () => { const w = F1.live(); if (!w) return;
  askConfirm('Cancel this weekend? The session and any calls are deleted and nothing counts towards the championship.', 'Cancel the weekend', () => run(async () => {
    for (const c of f1Calls(w)) await Data.remove('f1_calls', c.id);
    await Data.remove('f1_weekends', w.id); await Data.audit('f1.weekend-cancel', 'Weekend cancelled');
  }, 'Weekend cancelled.'), true); };

ACTIONS['f1-quali'] = () => {
  const w = F1.live(); if (!w || w.status !== 'practice') return;
  const track = F1.track(w.trackId), entrants = f1Entrants();
  if (entrants.length < 2) { toast('The grid needs at least two drivers.', true); return; }
  /* Set-up quality from the dials each team locked in; cars nobody locked in run a standard set-up. */
  const setup = {}, setupBy = {}, setupDials = {}, setupSource = {};
  /* Nothing has to be locked in: the chosen dials, else the latest set-up run, else the set-up from last time. */
  entrants.forEach(e => { if (!playerRun(w, e)) return; const ch = setupChoice(w, e); if (!ch) return;
    setup[e.id] = Math.min(95, f1SetupQuality(w, e.teamId, ch.dials, e) + rapportSetup(f1Rapport(e.teamId, e.car))); setupDials[e.id] = ch.dials; setupSource[e.id] = ch.source; if (ch.by) setupBy[e.id] = ch.by; });
  entrants.forEach(e => { if (setup[e.id] == null) setup[e.id] = f1AiSetup(F1.team(e.teamId)); });
  const rs = f1RaceSetup(w, track), circuit = rs.circuit, weather = f1Weather(w, track);
  const teams = F1.teams().map(t => f1EffectiveTeam(t));
  const entries = FormulaRacingAdapter.toEntries(entrants.map(e => e.v3), teams, track, { setup });
  /* Confidence from practice: up to two tenths a lap. */
  const confidence = {}; entrants.forEach(e => { confidence[e.id] = confidenceAfter(w, e, sessionsOf(w)); const en = entries.find(x => x.id === e.id); if (en) en.paceAdj = (en.paceAdj || 0) - CONF_MAX * confidence[e.id]; });
  engineEfficiency(entrants, entries, w);
  const penalties = f1PuEffects(w, entrants, entries);
  const quali = RaceEngine.qualify({ circuit, entries, weather, seed: w.seed, rules: rs.rules });
  const puLog = [], startGrid = f1PuGrid(quali.grid, penalties, puLog); quali.log = quali.log.concat(puLog);
  const state = RaceEngine.createRace({ circuit, entries, grid: startGrid, weather, seed: w.seed, sprint: w.session === 'sprint', rules: rs.rules });
  const ents = entrants.map(e => { const o = Object.assign({}, e); delete o.v3; return o; });
  const doc = Object.assign(clone(S.store.f1_weekends[w.id]), { status: curSeries().quali === 'single' ? 'grid' : 'quali', qualiStage: curSeries().quali === 'single' ? 3 : 1, entrants: ents, setup, setupBy, setupDials, setupSource, penalties, confidence, weather, quali: { grid: quali.grid, results: quali.results, log: quali.log }, state });
  run(async () => {
    await Data.put('f1_weekends', w.id, doc);
    for (const c of f1Calls(w)) await Data.remove('f1_calls', c.id);
    await Data.audit('f1.qualifying', `Qualifying: ${quali.log[quali.log.length - 1].text}`);
  }, curSeries().quali === 'single' ? 'Qualifying done. The grid is set.' : 'Q1 is done. Run Q2 when you’re ready.');
};

async function f1Advance(laps) {
  const w = F1.live(); if (!w || !w.state || w.state.finished || w.status === 'quali') return null;
  const calls = f1Calls(w), engineCalls = [], notes = [];
  calls.forEach(c => {
    if (c.type === 'setup' || c.type === 'moment' || !f1CallAllowed(c, w)) return;
    const ent = (w.entrants || []).find(e => e.id === c.carId);
    if (c.type === 'order') engineCalls.push({ team: c.teamId, type: 'order', value: c.value });
    else if (c.type === 'box') engineCalls.push({ entry: c.carId, type: 'box', compound: c.value });
    else if (c.type === 'strategy') { const sc = f1StrategyCall(w, c); if (!sc) return; engineCalls.push(sc); }
    else engineCalls.push({ entry: c.carId, type: c.type, value: c.value });
    notes.push({ kind: 'call', ids: ent ? [ent.id] : [], text: 'Pit wall, ' + f1CallText(c, w) });
  });
  /* Driver moments due this lap: the player's choice, or their instinct. */
  const mom = f1MomentCalls(w); engineCalls.push(...mom.calls);
  const stopSc = (S.ui.form.f1stopSc !== false);
  /* At the start, every car with saved plans takes its starting tyre and follows its plan. */
  let st = w.state.lap === 0 ? f1ApplyPlans(w, w.state) : w.state, log = [], lastLog = [];
  for (let i = 0; i < laps && !st.finished; i++) {
    const out = RaceEngine.stepLap(st, i === 0 ? engineCalls : []);
    if (i === 0 && notes.length) { notes.forEach(n => { n.lap = out.state.lap; }); out.state.events = out.state.events.slice(0, out.state.events.length - out.log.length).concat(notes, out.log); }
    st = out.state; log = log.concat(out.log); lastLog = out.log;
    if (stopSc && i < laps - 1 && out.log.some(l => l.kind === 'red' || ((l.kind === 'sc' || l.kind === 'vsc') && /deployed/.test(l.text)))) break;
  }
  const doc = Object.assign(clone(S.store.f1_weekends[w.id]), { status: st.finished ? 'finished' : 'running', state: st, live: !!S.f1live && !st.finished });
  /* Moments: record how the settled ones went, drop any that were missed, and look for new ones (one lap at a time only). */
  const settled = new Map(mom.resolved.map(m => [m.id, m]));
  doc.moments = (w.moments || []).map(m => { const r = settled.get(m.id); if (r) { const ev = log.find(l => l.kind === 'moment' && (l.ids || [])[0] === m.carId); return Object.assign(r, { outcome: ev ? ev.text : 'Nothing came of it.' }); }
    return !m.resolved && m.lap <= st.lap ? Object.assign({}, m, { resolved: true, expired: true }) : m; });
  if (laps === 1 && S.ui.form.f1moments !== false) doc.moments = doc.moments.concat(f1NewMoments(Object.assign({}, w, { moments: doc.moments }), st, lastLog));
  if (st.finished) {
    const byId = new Map((w.entrants || []).map(e => [e.id, e]));
    doc.results = RaceEngine.classify(st).map(r => Object.assign({}, r, byId.get(r.id) || {}));
    doc.finishedAt = nowIso();
    if (typeof weekendStaff === 'function') doc.staff = weekendStaff(w);
  }
  const ok = await run(async () => {
    await Data.put('f1_weekends', w.id, doc);
    for (const c of calls) await Data.remove('f1_calls', c.id);
    if (st.finished) await Data.audit('f1.result', (log.find(l => l.kind === 'finish') || {}).text || 'Race finished');
  }, st.finished ? 'Chequered flag. The result counts towards the championship.' : null);
  return ok ? log : null;
}
ACTIONS['f1-step'] = d => f1Advance(Number(d.laps) || 1);
ACTIONS['f1-view'] = d => { S.ui.f1view = d.id || null; render(); };

/* ---------------------------------------------------------------- Race Weekend screen */
function f1TyreChip(c, age) {
  const k = RaceEngine.COMPOUNDS[c]; if (!k) return '';
  return `<span class="f1-tyre ${c}" title="${k.label}">${k.short}</span>${age != null ? `<span class="f1-age">${age}</span>` : ''}`;
}
function f1Fmt(t) { if (t == null || !isFinite(t)) return '–'; const m = Math.floor(t / 60); return `${m}:${(t - m * 60).toFixed(3).padStart(6, '0')}`; }
function f1Order(st) {
  const run_ = st.cars.filter(c => c.status === 'running').sort((a, b) => a.cum - b.cum);
  return run_.concat(st.cars.filter(c => c.status !== 'running').sort((a, b) => (b.retiredLap || 0) - (a.retiredLap || 0)));
}
function f1Ent(w, id) { return (w.entrants || []).find(e => e.id === id) || { id, name: id, teamId: '' }; }
function f1DriverCell(w, c) {
  const e = f1Ent(w, c.id), mine = S.charId && e.charId === S.charId;
  return `<span class="f1-bar" style="background:${esc(f1Colour(e.teamId))}"></span><b>${esc(c.id)}</b> <span class="muted small">${esc(e.name)}</span>${e.charId ? ' <span class="tag player">Player</span>' : ''}${mine ? ' <span class="tag you">You</span>' : ''}`;
}
function f1TowerHtml(w) {
  const st = w.state;
  if (st.lap === 0) {
    const q = new Map(w.quali.results.map(r => [r.id, r]));
    return `<table class="data"><thead><tr><th>P</th><th>Driver</th><th class="num">Q1</th><th class="num">Q2</th><th class="num">Q3</th><th>Tyre</th></tr></thead><tbody>${st.cars.map((c, i) => { const r = q.get(c.id) || { times: [] };
      return `<tr><td><b>${i + 1}</b></td><td>${f1DriverCell(w, c)}</td>${[0, 1, 2].map(k => `<td class="num">${r.times[k] == null || !isFinite(r.times[k]) ? '' : f1Fmt(r.times[k])}</td>`).join('')}<td>${f1TyreChip(c.tyre.compound)}</td></tr>`; }).join('')}</tbody></table>`;
  }
  const order = f1Order(st), lead = order[0], avg = lead.cum / Math.max(1, st.lap);
  return `<table class="data"><thead><tr><th>P</th><th>Driver</th><th class="num">Gap</th><th class="num">Int</th><th>Tyre</th><th class="num">Last lap</th><th class="num">Pits</th></tr></thead><tbody>${order.map((c, i) => {
    if (c.status !== 'running') return `<tr><td>–</td><td>${f1DriverCell(w, c)}</td><td colspan="5" class="muted">Out on lap ${c.retiredLap}: ${esc(c.dnf)}</td></tr>`;
    const gap = c.cum - lead.cum, down = Math.floor(gap / avg), moved = c.grid - (i + 1);
    return `<tr><td><b>${i + 1}</b> ${moved ? `<span class="${moved > 0 ? 'f1-up' : 'f1-down'}">${moved > 0 ? '▲' : '▼'}${Math.abs(moved)}</span>` : ''}</td><td>${f1DriverCell(w, c)}</td>
      <td class="num">${i === 0 ? 'Leader' : down >= 1 ? `+${down} lap${down > 1 ? 's' : ''}` : '+' + gap.toFixed(1)}</td><td class="num">${i === 0 ? '' : '+' + (c.cum - order[i - 1].cum).toFixed(1)}</td>
      <td>${f1TyreChip(c.tyre.compound, c.tyre.age)}</td><td class="num">${f1Fmt(c.lastLap)}</td><td class="num">${c.stops}</td></tr>`; }).join('')}</tbody></table>`;
}
function f1ChartHtml(w) {
  const st = w.state, rows = st.lap ? f1Order(st) : st.cars, L = st.laps, rowH = 19, left = 46, right = 12, top = 22, W = 1000, H = top + rows.length * rowH + 8;
  const x = lap => left + (lap - 1) / L * (W - left - right), cw = (W - left - right) / L;
  const col = { soft: 'var(--f1-soft)', medium: 'var(--f1-medium)', hard: 'var(--f1-hard)', inter: 'var(--f1-inter)', wet: 'var(--f1-wet)' };
  const sc = {}; let on = null;
  st.events.forEach(e => { if ((e.kind === 'sc' || e.kind === 'vsc') && /deployed/.test(e.text)) on = e.lap + 1; if ((e.kind === 'sc' || e.kind === 'vsc') && /ends/.test(e.text) && on) { for (let l = on; l <= e.lap; l++) sc[l] = 1; on = null; } });
  if (on) for (let l = on; l <= st.lap; l++) sc[l] = 1;
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Tyre stints for every car">`;
  Object.keys(sc).forEach(l => { s += `<rect x="${x(+l)}" y="${top - 6}" width="${cw}" height="${H - top}" fill="var(--f1-flag)" opacity=".28"/>`; });
  for (let l = 1; l <= L; l++) if (l === 1 || l % 10 === 0) s += `<text x="${x(l) + cw / 2}" y="12" font-size="11" text-anchor="middle" fill="var(--muted)" font-family="Rajdhani, Arial Narrow, sans-serif">${l}</text><line x1="${x(l)}" x2="${x(l)}" y1="${top - 6}" y2="${H}" stroke="var(--line)"/>`;
  rows.forEach((c, i) => {
    const y = top + i * rowH, e = f1Ent(w, c.id);
    s += `<text x="${left - 8}" y="${y + 12}" font-size="13" text-anchor="end" font-weight="700" fill="var(--text)" font-family="Rajdhani, Arial Narrow, sans-serif">${esc(c.id)}</text><rect x="${left - 5}" y="${y + 2}" width="3" height="${rowH - 6}" fill="${esc(f1Colour(e.teamId))}"/>`;
    c.stints.forEach(t => { const to = t.to || st.lap; if (to < t.from) return;
      s += `<rect x="${x(t.from)}" y="${y + 3}" width="${Math.max(1, (to - t.from + 1) * cw - 1.5)}" height="${rowH - 8}" rx="2" fill="${col[t.compound]}" stroke="${t.compound === 'hard' ? 'var(--f1-hard-edge)' : 'none'}"/>`; });
    if (c.status !== 'running') s += `<text x="${x(c.retiredLap) + cw + 4}" y="${y + 12}" font-size="12" fill="var(--bad)">Out</text>`;
  });
  if (st.lap && !st.finished) s += `<line x1="${x(st.lap) + cw}" x2="${x(st.lap) + cw}" y1="${top - 6}" y2="${H}" stroke="var(--text)" stroke-width="1.5"/>`;
  return `<div class="scroll-x f1-chart">${s}</svg></div><div class="f1-legend"><span><i style="background:var(--f1-soft)"></i>Soft</span><span><i style="background:var(--f1-medium)"></i>Medium</span><span><i style="background:var(--f1-hard);box-shadow:inset 0 0 0 1px var(--f1-hard-edge)"></i>Hard</span><span><i style="background:var(--f1-inter)"></i>Intermediate</span><span><i style="background:var(--f1-wet)"></i>Wet</span><span><i style="background:var(--f1-flag);opacity:.5"></i>Safety car laps</span></div>`;
}
function f1FeedHtml(w) {
  const ev = ((w.state && w.state.events) || []).slice().reverse().slice(0, 150);
  const q = ((w.quali && w.quali.log) || []).slice().reverse().map(l => Object.assign({ lap: 'Q' }, l));
  const all = ev.concat(w.state && w.state.lap ? [] : q);
  if (!all.length) return '<p class="muted small">Overtakes, pit stops, safety cars and retirements are logged here lap by lap.</p>';
  return `<ul class="f1-feed">${all.map(l => `<li class="${esc(l.kind)}"><span class="l">${l.lap === 'Q' ? 'Q' : 'L' + esc(l.lap)}</span><span class="t">${esc(l.text)}</span></li>`).join('')}</ul>`;
}
function f1ResultsHtml(w) {
  return `<table class="data"><thead><tr><th>Pos</th><th>Driver</th><th>Team</th><th class="num">Grid</th><th>Gap</th><th class="num">Stops</th><th class="num">Best lap</th><th class="num">Points</th></tr></thead><tbody>${(w.results || []).map(r =>
    `<tr><td><b>${r.position || 'DNF'}</b></td><td><span class="f1-bar" style="background:${esc(f1Colour(r.teamId))}"></span>${esc(r.name)}${r.charId ? ' <span class="tag player">Player</span>' : ''}</td><td>${esc(F1.team(r.teamId).name)}</td>
     <td class="num">${r.grid}</td><td>${r.position === 1 ? f1Fmt(r.time) : esc(r.gap || '')}</td><td class="num">${r.stops}</td><td class="num">${f1Fmt(r.best)}</td><td class="num">${r.points || ''}</td></tr>`).join('')}</tbody></table>`;
}

/* The current character's pit wall: only the controls their seat allows. */
function f1PitWallHtml(w) {
  const seats = f1MySeats(); if (!seats.length) return '';
  const teamIds = [...new Set(seats.map(s => s.teamId))];
  const st = w.state, mine = f1Calls(w).filter(c => c.charId === S.charId);
  let h = '';
  teamIds.forEach(tid => {
    const t = F1.team(tid), tp = seats.some(s => s.teamId === tid && s.role === 'principal');
    const cars = (w.entrants || f1Entrants()).filter(e => e.teamId === tid);
    cars.forEach(e => {
      if (S.ui.wkCarNow && e.id !== S.ui.wkCarNow) return;
      const can = type => f1CallAllowed({ type, carId: e.id, teamId: null, charId: S.charId }, w);
      const car = st ? st.cars.find(c => c.id === e.id) : null;
      if (w.status === 'practice') {
        if (can('setup')) { h += f1PracticeHtml(w, e, t, f1Calls(w)); return; }
        /* A driver whose car has a player engineer follows the programme without running it. */
        if (seats.some(s => s.teamId === tid && s.role === 'driver' && s.car === e.car)) h += f1PracticeHtml(w, e, t, f1Calls(w), true);
        return;
      }
      if (!car || w.status === 'finished' || w.status === 'quali' || !st) return;
      if (st.lap === 0 && (can('setup') || seats.some(s => s.teamId === tid))) h += `<div class="f1-car" style="--team:${esc(t.color)}"><h3>${esc(e.name)}</h3>${qualiDebriefHtml(w, Object.assign({}, e, { v3: (f1Entrants().find(x => x.id === e.id) || {}).v3 }))}</div>`;
      if (car.status !== 'running') { h += `<div class="f1-car" style="--team:${esc(t.color)}"><h3>${esc(e.name)}</h3><p class="muted">Out: ${esc(car.dnf)}</p></div>`; return; }
      const life = RaceEngine.tyreLife(car.tyre.compound, car, st.circuit), wear = Math.min(100, Math.round(car.tyre.wear / life * 100)), pos = f1Order(st).indexOf(car) + 1;
      const pend = type => mine.find(c => c.type === type && c.carId === e.id);
      const pb = pend('box'), pm = pend('mode');
      h += `<div class="f1-car" style="--team:${esc(t.color)}"><h3>${esc(e.name)}</h3>
        <p class="muted small" style="margin:0">P${pos}, ${RaceEngine.COMPOUNDS[car.tyre.compound].label.toLowerCase()}s ${car.tyre.age} laps old, ${plural(car.stops, 'stop')}</p>
        <div class="f1-gauges"><div class="f1-gauge">Tyre wear ${wear}%<div class="track"><div class="fill ${wear >= 90 ? 'hot' : ''}" style="width:${wear}%"></div></div></div>
          ${st.rules.noHybrid ? `<div class="f1-gauge">${esc(engineFormula(wSeries(w), wSeason(w)).short)}: no battery</div></div>` : `<div class="f1-gauge">Battery ${Math.round(car.energy)}%<div class="track"><div class="fill" style="width:${car.energy}%"></div></div></div></div>`}
        ${can('mode') ? `<div class="f1-row"><span class="lbl">Mode</span>${['push', 'standard', 'manage'].map(m => `<button class="btn small" data-act="f1-call" data-type="mode" data-car="${esc(e.id)}" data-value="${m}" aria-pressed="${(pm ? pm.value : car.mode) === m}">${RaceEngine.MODES[m].label}</button>`).join('')}</div>` : ''}
        ${can('box') ? `<div class="f1-row"><span class="lbl">Box</span>${['soft', 'medium', 'hard', 'inter', 'wet'].map(k => `<button class="btn small" data-act="f1-call" data-type="box" data-car="${esc(e.id)}" data-value="${k}" aria-pressed="${!!(pb && pb.value === k)}">${f1TyreChip(k)} ${k === 'inter' ? 'Inter' : RaceEngine.COMPOUNDS[k].label}</button>`).join('')}</div>` : ''}
        ${can('refuseOrder') && st.orders[tid] ? `<div class="f1-row"><span class="lbl">Order</span><span class="small">The team says: ${st.orders[tid].value === 'hold' ? 'hold position' : 'swap the cars'}.</span><button class="btn small" data-act="f1-call" data-type="refuseOrder" data-car="${esc(e.id)}" aria-pressed="${!!pend('refuseOrder')}">Refuse the order</button></div>` : ''}
      </div>`;
    });
    if (tp && st && w.status === 'running' && !raceLocked(w)) {
      const cur = st.orders[tid] ? st.orders[tid].value : 'none', po = mine.find(c => c.type === 'order' && c.teamId === tid), v = po ? po.value : cur;
      h += `<div class="f1-row" style="border-top:1px solid var(--line);padding-top:10px"><span class="lbl">Orders</span>${[['none', 'Free to race'], ['hold', 'Hold positions'], ['swap', 'Swap the cars']].map(([k, l]) => `<button class="btn small" data-act="f1-call" data-type="order" data-team="${esc(tid)}" data-value="${k}" aria-pressed="${v === k}">${l}</button>`).join('')}</div>`;
    }
  });
  if (!h) return '';
  const pendingList = mine.filter(c => c.type !== 'setup' || w.status === 'practice');
  return `<section class="card" style="margin-bottom:16px"><h2>Your pit wall <span class="sub">${seats.map(s => `${F1_ROLE[s.role]}, ${F1.team(s.teamId).name}`).join('; ')}</span></h2>${h}
    ${pendingList.length ? `<p class="small" style="margin-top:10px"><b>Waiting for Race Control:</b> ${pendingList.map(c => `${esc(f1CallText(c, w))} <button class="btn small" data-act="f1-call-withdraw" data-id="${esc(c.id)}">Withdraw</button>`).join(' ')}</p>` : ''}
    ${w.status === 'practice' ? '' : `<p class="muted small">`}${w.status === 'practice' ? '' : (raceLocked(w) ? 'Official race: no changes from the pit wall. Your plans, triggers and race approach are running the car.' : 'Calls apply when Race Control runs the next lap. Anything you don’t call, the team’s plan decides.') + '</p>'}</section>`;
}

function f1OpenFormHtml() {
  const tracks = F1.tracks(); if (!tracks.length) return '';
  if (seasonClosed()) return `<section class="card"><h2>Between seasons</h2><p>${esc(curSeason().name)} is catalogued. Start the next season on the Seasons page to open weekends again.</p><button class="btn primary" data-act="nav" data-route="seasons">Seasons</button></section>`;
  const f = S.ui.form.f1w = S.ui.form.f1w || { trackId: (f1NextTrack() || {}).id, session: 'gp', weatherMode: 'track', seed: '', rainPct: 'track', scRate: '1', failRate: '1', extRate: '1', lock: true, practice: 'full' };
  const t = F1.track(f.trackId) || tracks[0];
  return `<section class="card"><h2>Open the next weekend</h2>
    <div class="metrics" style="align-items:end">
      <label class="field">Circuit${sel('f1w-track', 'ui/form/f1w/trackId', f.trackId, tracks.map(x => [x.id, `Round ${x.round}: ${x.name}`]))}</label>
      <label class="field">Session${sel('f1w-session', 'ui/form/f1w/session', f.session, [['gp', 'Grand Prix']].concat(t.hasSprint ? [['sprint', 'Sprint']] : [], [['test', 'Pre-season testing']]))}</label>
      <label class="field">Weather${sel('f1w-weather', 'ui/form/f1w/weatherMode', f.weatherMode, F1_WEATHER)}</label>
      <label class="field">Seed (optional)<input id="f1w-seed" type="number" min="1" data-bind="ui/form/f1w/seed" value="${esc(f.seed || '')}" placeholder="Random"></label>
    </div>
    ${randomnessHtml('f1w', f, t)}
    <label class="field" style="max-width:520px">Practice${sel('f1w-practice', 'ui/form/f1w/practice', f.practice || 'full', [['full', 'Full sessions: run like qualifying, with weather and incidents'], ['quick', 'Quick: runs report straight away, always dry']])}</label>
    <label class="small"><input type="checkbox" data-bind="ui/form/f1w/lock" ${f.lock !== false ? 'checked' : ''}> Official race: no pit-wall changes once it starts. The teams’ plans, triggers and race approaches run the cars.</label>
    <p class="muted small">${esc(t.circuit)}: ${t.laps} laps, ${esc(String(t.type).replace('-', ' '))}, ${t.wr}% rain risk. The seed makes the weekend repeatable: the same seed and the same calls give the same race.</p>
    <div class="btn-row"><button class="btn primary" data-act="f1-open">Open the weekend</button></div></section>`;
}

route('weekend', 'Race Weekend', function () {
  const head = (k, t, p, right) => `<div class="page-head"><div>${k ? `<p class="eyebrow">${k}</p>` : ''}<h1>${t}</h1>${p ? `<p>${p}</p>` : ''}</div>${right || ''}</div>`;
  if (!F1.teams().length) return head('', 'Race Weekend', 'The grid isn’t set up yet.') + (S.isGm ? '<div class="card"><p>Load today’s grid on The Grid page first.</p><button class="btn primary" data-act="nav" data-route="grid">Go to The Grid</button></div>' : '');
  const past = F1.weekends().filter(w => w.status === 'finished');
  const view = S.ui.f1view ? get('f1_weekends', S.ui.f1view) : null;
  const w = view || F1.live() || past[0] || null;
  const pastHtml = past.length ? `<section class="card" style="margin-top:16px"><h2>Results so far</h2><table class="data"><thead><tr><th>Round</th><th>Session</th><th>Winner</th><th></th></tr></thead><tbody>${past.map(x => { const t = F1.track(x.trackId) || {}, win = (x.results || [])[0] || {};
      return `<tr><td>${esc(t.round || '')} ${esc(t.name || x.trackId)}</td><td>${x.session === 'sprint' ? 'Sprint' : 'Grand Prix'}</td><td><span class="f1-bar" style="background:${esc(f1Colour(win.teamId))}"></span>${esc(win.name || '')}</td><td><button class="btn small" data-act="f1-view" data-id="${esc(x.id)}">View</button></td></tr>`; }).join('')}</tbody></table></section>` : '';
  if (!w) return head('', 'Race Weekend', S.isGm ? 'Open a weekend, let teams send their set-ups, run qualifying, then run the race lap by lap.' : 'No weekend is open. Race Control opens each one.') + (S.isGm ? f1OpenFormHtml() : '') + pastHtml;

  const t = F1.track(w.trackId) || { name: w.trackId, laps: 0 }, st = w.state, sprint = w.session === 'sprint';
  const laps = st ? st.laps : (sprint ? Math.ceil(t.laps / 3) : t.laps);
  const lapLbl = !st ? 'Practice' : st.finished ? 'Chequered flag' : st.lap === 0 ? 'Grid set' : 'Lap';
  const right = `<div class="f1-lap" aria-live="polite"><small>${lapLbl}</small>${st ? `${st.lap}<span class="of">/${laps}</span>` : '–'}</div>`;
  const track = st ? st.track[Math.max(0, st.lap - 1)] : 0;
  const chips = st ? `<p style="margin:6px 0 0"><span class="tag ${track === 2 ? 'wet' : track === 1 ? 'damp' : ''}">${['Dry', 'Damp', 'Wet'][track]} track</span>${st.sc.type ? ` <span class="tag flag">${st.sc.type === 'sc' ? 'Safety car' : 'Virtual safety car'}</span>` : ''}${st.fastest ? ` <span class="tag">Fastest lap ${esc(st.fastest.id)} ${f1Fmt(st.fastest.time)}</span>` : ''}</p>` : '';
  let h = head(`Round ${esc(t.round || '')}${sprint ? ', sprint' : ''}`, `${esc(t.flag || '')} ${esc(t.name)}${sprint ? ' Sprint' : ''}`,
    `${esc(t.circuit || '')}, ${laps} laps. ${w.status === 'practice' ? 'Practice: teams are sending set-ups.' : ''}${w.status === 'finished' ? 'Final result.' : ''}` + chips, right);
  if (view) h += `<div class="btn-row" style="margin-bottom:12px"><button class="btn" data-act="f1-view">Back to the current weekend</button></div>`;

  if (S.isGm && !view) {
    const calls = f1Calls(w), setups = calls.filter(c => c.type === 'setup').length, pending = calls.length - setups;
    if (w.status === 'practice') h += `<section class="card" style="margin-bottom:16px"><h2>Race Control</h2><p>${setups ? plural(setups, 'set-up') + ' received from the teams.' : 'No set-ups received yet; cars without one run a standard set-up.'}</p>
      <div class="btn-row"><button class="btn primary" data-act="f1-quali">Run qualifying</button><button class="btn" data-act="f1-cancel">Cancel the weekend</button></div></section>`;
    else if (w.status !== 'finished') h += `<section class="card" style="margin-bottom:16px"><h2>Race Control <span class="sub">${pending ? plural(pending, 'pit-wall call') + ' waiting' : 'No calls waiting'}</span></h2>
      <div class="btn-row" style="align-items:center"><button class="btn primary" data-act="f1-step" data-laps="1">${st.lap === 0 ? 'Start the race' : 'Next lap'}</button>
        <button class="btn" data-act="f1-step" data-laps="5">Run 5 laps</button><button class="btn" data-act="f1-step" data-laps="999">Run to the flag</button>
        <label class="small"><input type="checkbox" data-act="f1-stopsc" ${S.ui.form.f1stopSc !== false ? 'checked' : ''}> Stop when a safety car comes out</label>
        <button class="btn" data-act="f1-cancel">Cancel the weekend</button></div>
      <p class="muted small">Waiting calls apply on the next lap you run. Stopping at a safety car gives the teams time to call their stops.</p></section>`;
    else h += `<section class="card" style="margin-bottom:16px"><h2>Race Control</h2><p>This weekend is finished and counts towards the championship.</p>
      <div class="btn-row"><button class="btn" data-act="f1-discord" data-id="${esc(w.id)}">Post the result to Discord</button></div></section>` + f1OpenFormHtml();
  }
  if (!view && w.status !== 'finished') h += f1PitWallHtml(w);

  if (!st) {
    const ents = f1Entrants();
    h += `<section class="card"><h2>Entry list</h2><table class="data"><thead><tr><th>Car</th><th>Driver</th><th>Team</th></tr></thead><tbody>${ents.map(e => `<tr><td><b>${esc(e.id)}</b></td><td>${esc(e.name)}${e.charId ? ' <span class="tag player">Player</span>' : ''}</td><td><span class="f1-bar" style="background:${esc(f1Colour(e.teamId))}"></span>${esc(F1.team(e.teamId).name)}</td></tr>`).join('')}</tbody></table>
      <p class="muted small">The entry list is fixed when qualifying runs, so seat changes after that apply from the next weekend.</p></section>`;
    return h + pastHtml;
  }
  if (w.status === 'finished') h += `<section class="card" style="margin-bottom:16px"><h2>Classification</h2><div class="scroll-x">${f1ResultsHtml(w)}</div></section>`;
  h += `<div class="f1-main"><section class="card"><h2>Timing</h2><div class="scroll-x">${f1TowerHtml(w)}</div></section>
    <section class="card"><h2>Race control</h2>${f1FeedHtml(w)}</section></div>
    <section class="card" style="margin-top:16px"><h2>Tyre strategy</h2>${f1ChartHtml(w)}</section>`;
  return h + (view ? '' : pastHtml);
});
ACTIONS['f1-stopsc'] = (d, el) => { S.ui.form.f1stopSc = !!el.checked; };

/* ---------------------------------------------------------------- Championship */
function f1Standings() {
  const drivers = new Map(), teams = new Map();
  F1.weekends().filter(w => w.status === 'finished').slice().reverse().forEach(w => (w.results || []).forEach(r => {
    const d = drivers.get(r.personId) || { personId: r.personId, name: r.name, teamId: r.teamId, charId: r.charId, pts: 0, wins: 0, podiums: 0, starts: 0, best: 99 };
    d.pts += r.points || 0; d.starts += 1; d.teamId = r.teamId; d.name = r.name;
    if (w.session !== 'sprint' && r.position) { if (r.position === 1) d.wins += 1; if (r.position <= 3) d.podiums += 1; d.best = Math.min(d.best, r.position); }
    drivers.set(r.personId, d);
    const t = teams.get(r.teamId) || { teamId: r.teamId, pts: 0, wins: 0 }; t.pts += r.points || 0; if (w.session !== 'sprint' && r.position === 1) t.wins += 1; teams.set(r.teamId, t);
  }));
  const order = (a, b) => b.pts - a.pts || b.wins - a.wins || (a.best || 99) - (b.best || 99);
  return { drivers: [...drivers.values()].sort(order), teams: [...teams.values()].sort(order) };
}
route('standings', 'Championship', function () {
  const s = f1Standings(), races = F1.weekends().filter(w => w.status === 'finished' && w.session === 'gp').length;
  const head = `<div class="page-head"><div><h1>Championship</h1><p>${esc(curSeries().name)}, ${esc(curSeason().name)} season. ${races ? `After ${races} Grand Prix${races === 1 ? '' : ' weekends'}${F1.weekends().some(w => w.status === 'finished' && w.session === 'sprint') ? ' and the sprints' : ''}. Points go to whoever drove the car that weekend.` : 'No races yet. Standings appear after the first chequered flag.'}</p></div>${s.drivers.length ? '<div class="btn-row"><button class="btn" data-act="share-open" data-kind="drivers">Export standings</button></div>' : ''}</div>`;
  if (!s.drivers.length) return head;
  return head + `<div class="cols2" style="align-items:start"><section class="card"><h2>Drivers</h2><div class="scroll-x"><table class="data"><thead><tr><th>Pos</th><th>Driver</th><th>Team</th><th class="num">Wins</th><th class="num">Podiums</th><th class="num">Points</th></tr></thead><tbody>${s.drivers.map((d, i) =>
      `<tr${S.charId && d.charId === S.charId ? ' class="me"' : ''}><td><b>${i + 1}</b></td><td>${careerLink(d.personId, d.name)}${d.charId ? ' <span class="tag player">Player</span>' : ''}</td><td><span class="f1-bar" style="background:${esc(f1Colour(d.teamId))}"></span>${esc(F1.team(d.teamId).name)}</td><td class="num">${d.wins}</td><td class="num">${d.podiums}</td><td class="num"><b>${d.pts}</b></td></tr>`).join('')}</tbody></table></div></section>
    <section class="card"><h2>Constructors</h2><div class="scroll-x"><table class="data"><thead><tr><th>Pos</th><th>Team</th><th class="num">Wins</th><th class="num">Points</th></tr></thead><tbody>${s.teams.map((t, i) =>
      `<tr><td><b>${i + 1}</b></td><td><span class="f1-bar" style="background:${esc(f1Colour(t.teamId))}"></span>${esc(F1.team(t.teamId).name)}</td><td class="num">${t.wins}</td><td class="num"><b>${t.pts}</b></td></tr>`).join('')}</tbody></table></div></section></div>`;
});

/* =====================================================================
   F1 SIM — roles: the race engineer's practice programme, the team
   principal's budget and upgrades, and driver careers.
   Everything here is worked out from the records each time it's needed,
   and checked against the seats, so a player can't make a car faster by
   writing a number: upgrades count only once Race Control has locked
   them in, and development points only up to what the races started have earned.
   ===================================================================== */
'use strict';

const F1_RULES = { setupCoef: 0.01 };   // a perfect set-up against a poor one: about three tenths a lap
const h32 = (...parts) => { let h = 2166136261; parts.join('|').split('').forEach(ch => { h = Math.imul(h ^ ch.charCodeAt(0), 16777619); }); return h >>> 0; };
const roll = (...parts) => RaceEngine.rng(h32(...parts))();
const clampN = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const f1Gauss = r => { const u = 1 - r(), v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
const finishedGps = () => F1.weekends().filter(w => w.status === 'finished' && w.session === 'gp').sort((a, b) => String(a.finishedAt).localeCompare(String(b.finishedAt)));
const finishedAll = () => F1.weekends().filter(w => w.status === 'finished').sort((a, b) => String(a.finishedAt).localeCompare(String(b.finishedAt)));

/* ================================================================ practice programme */
const DIALS = [['wing', 'Downforce', 'low', 'high'], ['susp', 'Suspension', 'soft', 'stiff'], ['diff', 'Differential', 'open', 'locked']];
const TYPE_IDEAL = { 'low-downforce': { wing: 18, susp: 62 }, 'high-speed': { wing: 40, susp: 70 }, mixed: { wing: 55, susp: 52 },
  technical: { wing: 70, susp: 45 }, 'high-downforce': { wing: 78, susp: 50 }, street: { wing: 85, susp: 30 } };
const F1_RUNS_PER_CAR = 4;
/* Each team's ideal set-up for the weekend: the circuit decides roughly where it is, the car moves it. Nobody sees it. */
function f1Ideal(w, teamId) {
  const t = F1.track(w.trackId) || {}, b = TYPE_IDEAL[t.type] || TYPE_IDEAL.mixed, r = k => roll(w.seed, teamId, k);
  return { wing: clampN(Math.round(b.wing + (r('w') - 0.5) * 24), 5, 95), susp: clampN(Math.round(b.susp + (r('s') - 0.5) * 30), 5, 95), diff: Math.round(25 + r('d') * 50) };
}
function f1SetupQuality(w, teamId, dials, ent) {
  if (!dials || typeof dials !== 'object') return null;
  /* With the car known, the driver's style moves the ideal. */
  const i = ent ? f1IdealFor(w, ent) : f1Ideal(w, teamId), d = k => Math.abs(clampN(Number(dials[k]) || 50, 0, 100) - i[k]);
  return clampN(Math.round(95 - d('wing') * 0.5 - d('susp') * 0.4 - d('diff') * 0.3), 20, 95);
}
/* Cars nobody works on run a competent standard set-up, a little better at the bigger teams. */
const f1AiSetup = team => clampN(Math.round(62 + ((team.carPace || 80) - 80) * 0.3), 50, 75);
/* Who may use a car's practice runs: the team principal, the car's race engineer, or its driver if no player engineers it. */
function f1CanRun(w, ent, charId) {
  if (!ent || !charId) return false;
  const seats = F1.seats(ent.teamId).filter(s => s.holderCharId === charId); if (!seats.length) return false;
  if (seats.some(s => s.role === 'principal') || seats.some(s => s.role === 'engineer' && s.car === ent.car)) return true;
  const eng = F1.seats(ent.teamId).find(s => s.role === 'engineer' && s.car === ent.car);
  return seats.some(s => s.role === 'driver' && s.car === ent.car) && !(eng && eng.holderCharId);
}
/* Runs count in the order they were made, up to the limit per car. */
const f1Runs = (w, carId) => list('f1_runs').filter(r => r.weekendId === w.id && r.carId === carId && (typeof involveAllows !== 'function' || involveAllows(r.charId, 'setup'))).sort((a, b) => String(a.at).localeCompare(String(b.at)));
function f1Lap(circuit, entry, setup) {
  return circuit.baseLap - (RaceEngine.carScore(entry.car, circuit) - 85) * RaceEngine.DEFAULTS.carCoef - (entry.driver.pace - 85) * RaceEngine.DEFAULTS.driverCoef - (setup - 60) * F1_RULES.setupCoef;
}
const ADJ = d => Math.abs(d) < 12 ? 'a touch' : Math.abs(d) < 25 ? 'a bit' : 'a lot';
const NOTES = {
  wing: [d => `Draggy on the straights. Take ${ADJ(d)} of wing off.`, d => `Light and nervous in the fast corners. Add ${ADJ(d)} more wing.`],
  susp: [d => `Skipping over the bumps and kerbs. Soften it ${ADJ(d)}.`, d => `Lazy changing direction. Stiffen it ${ADJ(d)}.`],
  diff: [d => `Pushing wide on the way out of corners. Open the diff ${ADJ(d)}.`, d => `Snappy on the throttle out of the slow corners. Lock the diff ${ADJ(d)}.`]
};
/* What a run tells the team. Pure: the same run always says the same thing. Experienced drivers give clearer feedback. */
function f1RunResult(w, ent, run) {
  /* Full practice: nothing to report until the session has run; lost runs report why; conditions change what a run tells you. */
  const ctx = runContext(w, run); if (ctx && ctx.pending) return { pending: true }; if (ctx && ctx.lost) return { lost: ctx.lost };
  const cond = (ctx && ctx.cond) || 'dry', wp = WET_PEN[cond];
  const track = F1.track(w.trackId), circuit = FormulaRacingAdapter.toCircuit(track), r = RaceEngine.rng(h32(w.seed, ent.id, run.id));
  const team = f1EffectiveTeam(F1.team(ent.teamId)), entry = FormulaRacingAdapter.toEntries([ent.v3], [team], track, {})[0];
  const noise = (2 + (100 - (ent.v3.experience || 50)) / 12) * rapportNoise(f1Rapport(ent.teamId, ent.car));
  if (run.kind === 'setup') {
    const i = f1IdealFor(w, ent), q = f1SetupQuality(w, ent.teamId, run.dials, ent);
    const notes = DIALS.map(([k, label]) => { const d = (Number(run.dials[k]) || 50) - i[k] + f1Gauss(r) * noise * (cond === 'dry' ? 1 : 2.5);
      return `${label}: ${Math.abs(d) < 5 ? 'feels right.' : NOTES[k][d > 0 ? 0 : 1](d).replace(/^./, c => c.toLowerCase())}`; });
    return { lap: f1Lap(circuit, entry, q) + 0.8 + wp + f1Gauss(r) * 0.08, cond, q, notes: cond === 'dry' ? notes : [`The track was ${cond}: the balance is hard to read, so treat this feedback with care.`].concat(notes) };
  }
  if (run.kind === 'long') {
    const c = RaceEngine.COMPOUNDS[run.compound] ? run.compound : 'medium';
    if (cond !== 'dry' && !RaceEngine.COMPOUNDS[c].wet) return { cond, wet: true, compound: cond === 'wet' ? 'wet' : 'inter', life: null, lap: f1Lap(circuit, entry, 60) + 2.2 + wp + f1Gauss(r) * 0.2 };
    const life = RaceEngine.tyreLife(c, { driver: entry.driver, car: entry.car }, circuit) * (1 + f1Gauss(r) * 0.03 * noise / 4);
    return { compound: c, life: Math.max(4, Math.round(life)), lap: f1Lap(circuit, entry, 60) + RaceEngine.COMPOUNDS[c].offset + 2.2 + wp + f1Gauss(r) * 0.1, cond };
  }
  /* Qualifying simulation: one lap against everyone else's likely pace. */
  const last = f1Runs(w, ent.id).filter(x => x.kind === 'setup' && x.at <= run.at).pop();
  const mySetup = last ? f1SetupQuality(w, ent.teamId, last.dials, ent) : f1AiSetup(team);
  const teams = F1.teams().map(t => f1EffectiveTeam(t));
  const all = FormulaRacingAdapter.toEntries(f1Entrants().map(e => e.v3), teams, track, {});
  const mine = f1Lap(circuit, entry, mySetup);
  const faster = all.filter(e => e.id !== ent.id).filter(e => f1Lap(circuit, e, f1AiSetup(F1.team(e.team))) < mine).length;
  const pos = clampN(faster + 1 + Math.round(f1Gauss(r) * 1.2), 1, all.length);
  const spread = cond === 'dry' ? 1 : 4;
  return { lap: mine - RaceEngine.DEFAULTS.fuelEffect - 0.35 + wp + f1Gauss(r) * 0.06, from: Math.max(1, pos - spread), to: Math.min(all.length, pos + spread), cond };
}
ACTIONS['f1-run'] = d => {
  const w = F1.live(), c = currentChar(); if (!w || w.status !== 'practice' || !c) return;
  const ent = f1Entrants().find(e => e.id === d.car);
  if (!f1CanRun(w, ent, c.id)) { toast('Your seat doesn’t run this car.', true); return; }
  if (endedSessions(w).length >= sessionsOf(w)) { toast('Practice is over. Qualifying is next.', true); return; }
  if (runsIn(w, ent.id, curSession(w)).length >= runsPerSession(w)) { toast(`This car has used its ${runsPerSession(w)} runs in ${sessionName(w, curSession(w))}. More in the next session.`, true); return; }
  const dials = Object.assign({ wing: 50, susp: 50, diff: 50 }, (S.ui.form.f1d || {})[ent.id] || {});
  DIALS.forEach(([k]) => { dials[k] = clampN(Math.round(Number(dials[k]) || 0), 0, 100); });
  const compound = ((S.ui.form.f1long || {})[ent.id]) || 'medium';
  run(async () => { await Data.put('f1_runs', newId('run'), { userId: asOwner(), charId: c.id, weekendId: w.id, carId: ent.id, session: curSession(w), kind: d.kind, dials, compound, at: nowIso() }); },
    fullPractice(w) ? `Run planned for ${sessionName(w, curSession(w))}. Results come when Race Control runs the session.` : d.kind === 'setup' ? 'Run done. Read what the driver said.' : 'Run done.');
};
ACTIONS['f1-lock'] = d => {
  const dials = Object.assign({ wing: 50, susp: 50, diff: 50 }, (S.ui.form.f1d || {})[d.car] || {});
  DIALS.forEach(([k]) => { dials[k] = clampN(Math.round(Number(dials[k]) || 0), 0, 100); });
  f1SendCall({ type: 'setup', carId: d.car, value: dials });
};
const dialText = v => DIALS.map(([k, l]) => `${l.toLowerCase()} ${v[k]}`).join(', ');
function f1PracticeHtml(w, e, t, mine, ro) {
  const runs = f1Runs(w, e.id), over = endedSessions(w).length >= sessionsOf(w), n = curSession(w), left = over ? 0 : runsPerSession(w) - runsIn(w, e.id, n).length;
  const form = S.ui.form.f1d = S.ui.form.f1d || {};
  if (!form[e.id]) { const lastSetup = runs.filter(x => x.kind === 'setup').pop(); form[e.id] = Object.assign({ wing: 50, susp: 50, diff: 50 }, lastSetup ? lastSetup.dials : {}); }
  const f = form[e.id], locked = mine.find(c => c.type === 'setup' && c.carId === e.id);
  const long = (S.ui.form.f1long = S.ui.form.f1long || {})[e.id] || 'medium';
  const ent = Object.assign({}, e, { v3: (f1Entrants().find(x => x.id === e.id) || {}).v3 });
  /* One run, as a line. */
  const runLine = r => { const x = f1RunResult(w, ent, r);
    const sn = `<span class="muted small">${sessionName(w, r.session || 1)}</span> `, kl = r.kind === 'setup' ? `set-up run (${esc(dialText(r.dials))})` : r.kind === 'long' ? `long run on ${esc(RaceEngine.COMPOUNDS[r.compound] ? RaceEngine.COMPOUNDS[r.compound].label.toLowerCase() : 'medium')}s` : 'qualifying simulation';
    const wt = x.cond && x.cond !== 'dry' ? ` <span class="tag">${esc(x.cond)} track</span>` : '';
    if (x.pending) return `<li>${sn}<b>Planned:</b> ${kl}. It runs when Race Control runs ${esc(sessionName(w, r.session || 1))}. ${ro ? '' : `<button class="btn small ghost" data-act="run-cancel" data-id="${esc(r.id)}">Take it off the plan</button>`}</li>`;
    if (x.lost) return `<li>${sn}<b>Lost:</b> ${kl}. ${esc(x.lost)}</li>`;
    if (x.wet) return `<li>${sn}<b>Long run</b>${wt}: too wet for slicks, so it ran on ${x.compound === 'wet' ? 'full wets' : 'intermediates'}. No dry tyre data. Average lap ${f1Fmt(x.lap)}.</li>`;
    if (r.kind === 'setup') return `<li>${sn}<b>Set-up run</b> (${esc(dialText(r.dials))})${wt}: ${f1Fmt(x.lap)}<ul>${x.notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul></li>`;
    if (r.kind === 'long') return `<li>${sn}<b>Long run on ${esc(RaceEngine.COMPOUNDS[x.compound].label.toLowerCase())}s</b>: about ${x.life} laps before the time falls away. Average lap ${f1Fmt(x.lap)} on full tanks.</li>`;
    return `<li>${sn}<b>Qualifying simulation</b>${wt}: ${f1Fmt(x.lap)}, which looks like P${x.from} to P${x.to} on one lap.</li>`; };
  const focus = over ? Math.max(1, ...runs.map(r => r.session || 1), 1) : n;
  const now = runs.filter(r => (r.session || 1) === focus).slice().reverse().map(runLine).join(''), earlier = runs.filter(r => (r.session || 1) !== focus).slice().reverse();
  const choice = setupChoiceText(w, ent);
  return `<div class="f1-car" style="--team:${esc(t.color)}"><h3>${esc(e.name)}</h3>
    <p class="muted small"><b>${over ? 'Practice is over' : esc(sessionName(w, n))}</b>${over ? '' : `: ${left ? plural(left, 'run') + ' left' : 'all runs used; more in the next session'}`}.${fullPractice(w) && !over ? ` Planned runs play out when Race Control runs the session. ${esc(practiceForecastText(w))}` : ''}</p>
    ${ro ? `<p class="small">${esc((F1.seats(e.teamId).find(s => s.role === 'engineer' && s.car === e.car) || {}).holderName || 'Your race engineer')} runs this car’s practice. Here’s what’s planned, what you’ve told them, and the debriefs.</p>` : ''}
    ${setupGuideHtml(w, ent, ro)}
    ${ro ? '' : `<div class="dials">${DIALS.map(([k, l, lo, hi]) => `<label class="field">${l} <span class="muted">(0 ${lo}, 100 ${hi})</span><input id="f1d-${esc(e.id)}-${k}" type="number" min="0" max="100" step="1" value="${esc(f[k])}" data-bind="ui/form/f1d/${esc(e.id)}/${k}" data-type="number"></label>`).join('')}</div>
    <div class="btn-row"><button class="btn primary" data-act="f1-run" data-kind="setup" data-car="${esc(e.id)}" ${left ? '' : 'disabled'}>${fullPractice(w) ? 'Plan a set-up run' : 'Set-up run'}</button>
      <label class="sr-only" for="f1long-${esc(e.id)}">Tyre for the long run</label>${sel('f1long-' + e.id, 'ui/form/f1long/' + e.id, long, [['soft', 'Softs'], ['medium', 'Mediums'], ['hard', 'Hards']])}
      <button class="btn" data-act="f1-run" data-kind="long" data-car="${esc(e.id)}" ${left ? '' : 'disabled'}>${fullPractice(w) ? 'Plan a long run' : 'Long run'}</button>
      <button class="btn" data-act="f1-run" data-kind="quali" data-car="${esc(e.id)}" ${left ? '' : 'disabled'}>${fullPractice(w) ? 'Plan a qualifying simulation' : 'Qualifying simulation'}</button></div>`}
    ${now ? `<h4>${esc(sessionName(w, focus))}</h4><ul class="runs">${now}</ul>` : ''}
    ${S.ui.wkRail ? '' : practiceDebriefsHtml(w, ent)}
    ${earlier.length ? `<details><summary>Earlier runs (${earlier.length})</summary><ul class="runs">${earlier.map(runLine).join('')}</ul></details>` : ''}
    <div class="quali-setup"><p class="small"><b>For qualifying:</b> ${esc(choice)} ${locked ? '' : '<span class="muted">Nothing needs locking in.</span>'}</p>
      ${ro ? '' : `<button class="btn small" data-act="f1-lock" data-car="${esc(e.id)}">${locked ? 'Use these dials instead' : 'Use these dials for qualifying'}</button>`}</div></div>`;
}

/* ================================================================ team car: effective stats */
const tpSeat = teamId => F1.seats(teamId).find(s => s.role === 'principal');
/* The car for race n+1 (n races finished): base numbers plus engine and development points. */
function f1EffectiveTeam(team, n) {
  if (!team) return team;
  n = n == null ? finishedGps().length : n;
  const out = Object.assign({}, team);
  engineApply(team, out);
  if (curSeries().development) teamDevApply(team.id, out, n);
  return out;
}

/* ================================================================ driver careers */
const DEV_ATTRS = F1_RATINGS.map(r => r[0]).filter(k => k !== 'experience');
const devCost = v => v < 80 ? 1 : v < 90 ? 2 : 3;
/* Each person's race-by-race record, from the results. */
function f1Record(personId) {
  const out = [];
  F1.allWeekends().filter(w => w.status === 'finished').sort((a, b) => String(a.finishedAt).localeCompare(String(b.finishedAt))).forEach(w => {
    const r = (w.results || []).find(x => x.personId === personId); if (!r) return;
    const mate = (w.results || []).find(x => x.teamId === r.teamId && x.personId !== personId);
    const pole = w.quali && w.quali.grid && w.quali.grid[0] === r.id;
    out.push({ w, r, mate, pole, beat: !!mate && (r.position || 99) < (mate.position || 99), qbeat: !!mate && r.grid < mate.grid });
  });
  return out;
}
/* Driver development: 2 points for every 3 Grands Prix started, per season of a series, up to 2 for every 3 rounds on its calendar.
   Years of experience scale it (younger drivers earn more). Unspent points carry on to the next season. */
function devSeasons(personId) {
  const m = new Map();
  f1Record(personId).filter(x => x.w.session === 'gp').forEach(x => { const k = wSeries(x.w) + '|' + wSeason(x.w); m.set(k, (m.get(k) || 0) + 1); });
  return [...m.entries()].map(([k, starts]) => { const [sid, season] = k.split('|'), s = seriesDoc(sid), rounds = (s.calendar && s.calendar.length) || list('f1_tracks').length || 23, cap = Math.floor(rounds / RACES_PER_DEV) * DEV_PTS_PER_BATCH;
    return { sid, season, starts, cap, earned: Math.min(cap, Math.floor(starts / RACES_PER_DEV) * DEV_PTS_PER_BATCH) }; });
}
function devEarned(personId) {
  const growth = (F1.person(personId) || {}).growth || 1;
  return devSeasons(personId).reduce((s, x) => s + Math.floor(x.earned * growth), 0);
}
/* A player's driver with their development spent: in order, while the points last. Experience grows with every second start. */
function f1DevApply(v3, charId) {
  if (!charId) return v3;
  const pid = f1PcId(charId), out = Object.assign({}, v3);
  const starts = f1Record(pid).filter(x => x.w.session === 'gp').length;
  out.experience = Math.min(99, (out.experience || 40) + Math.floor(starts / 2));
  let left = devEarned(pid);
  list('f1_dev').filter(x => x.charId === charId && DEV_ATTRS.indexOf(x.attr) !== -1).sort((a, b) => String(a.at).localeCompare(String(b.at))).forEach(x => {
    const cost = devCost(out[x.attr] || 0); if (cost > left || (out[x.attr] || 0) >= 99) return;
    out[x.attr] = Math.round(((out[x.attr] || 0) + 0.8) * 10) / 10; left -= cost;
  });
  Object.defineProperty(out, 'devLeft', { value: left, enumerable: false });
  return out;
}
ACTIONS['dev-spend'] = d => {
  const c = currentChar(); if (!c || c.id !== d.char) return;
  const base = Object.assign({}, F1_ROOKIE, F1.person(f1PcId(c.id)) || {}), now = f1DevApply(base, c.id);
  if (devCost(now[d.attr] || 0) > now.devLeft) { toast('Not enough development points yet. Drivers earn 2 points for every 3 Grands Prix.', true); return; }
  run(async () => { await Data.put('f1_dev', newId('dev'), { userId: asOwner(), charId: c.id, attr: d.attr, at: nowIso() }); }, `${F1_RATINGS.find(r => r[0] === d.attr)[1]} up by 0.8.`);
};
ACTIONS.career = d => { S.ui.career = d.id; go('career'); };
const careerLink = (personId, name) => personId ? `<button class="linkish" data-act="career" data-id="${esc(personId)}">${esc(name)}</button>` : esc(name);

function devPanelHtml(charId) {
  const base = Object.assign({}, F1_ROOKIE, F1.person(f1PcId(charId)) || {}), now = f1DevApply(base, charId), mine = S.charId === charId;
  const p = F1.person(f1PcId(charId)) || {}, seasons = devSeasons(f1PcId(charId)), here = seasons.find(x => x.sid === curSeriesId() && x.season === curSeasonId()), s = curSeries();
  const cap = Math.floor((((s.calendar && s.calendar.length) || list('f1_tracks').length || 23)) / RACES_PER_DEV) * DEV_PTS_PER_BATCH, starts = here ? here.starts : 0, got = here ? here.earned : 0;
  const growth = p.growth && p.growth !== 1 ? ` Their years of experience make each point worth ×${p.growth}.` : '';
  return `<div class="dev"><p><b>${plural(now.devLeft, 'development point')}</b> to spend. Drivers earn ${DEV_PTS_PER_BATCH} for every ${RACES_PER_DEV} Grands Prix, up to ${cap} a season.${growth}</p>
    <p class="muted small">This season: ${plural(starts, 'Grand Prix', 'Grands Prix')}, ${got} of ${cap} earned${got < cap ? `, the next batch after ${RACES_PER_DEV - (starts % RACES_PER_DEV)} more` : ''}. Unspent points carry on to next season.</p>
    <table class="data compact"><tbody>${F1_RATINGS.map(([k, l]) => `<tr><td>${esc(l)}</td><td class="num"><b>${now[k]}</b>${now[k] !== base[k] ? ` <span class="f1-up">+${Math.round((now[k] - base[k]) * 10) / 10}</span>` : ''}</td>
      <td class="num">${mine && k !== 'experience' && now[k] < 99 ? `<button class="btn small" data-act="dev-spend" data-char="${esc(charId)}" data-attr="${k}" ${devCost(now[k]) > now.devLeft ? 'disabled' : ''}>+0.8 for ${plural(devCost(now[k]), 'point')}</button>` : k === 'experience' ? '<span class="muted small">Grows with races</span>' : ''}</td></tr>`).join('')}</tbody></table></div>`;
}

route('career', 'Career', function () {
  const p = F1.person(S.ui.career);
  if (!p) return `<div class="empty">Choose a driver from The Grid or the Championship.</div>`;
  const rec = f1Record(p.id), gps = rec.filter(x => x.w.session === 'gp'), seat = list('f1_seats').find(s => (p.charId && s.holderCharId === p.charId) || (!p.charId && s.defaultPersonId === p.id && !s.holderCharId));
  const team = seat ? F1.team(seat.teamId) : F1.team(p.teamId), c = p.charId ? get('characters', p.charId) : null;
  const pts = rec.reduce((s, x) => s + (x.r.points || 0), 0), wins = gps.filter(x => x.r.position === 1).length, pods = gps.filter(x => x.r.position && x.r.position <= 3).length;
  const best = Math.min(...gps.map(x => x.r.position || 99)), dnf = gps.filter(x => !x.r.position).length, poles = gps.filter(x => x.pole).length;
  const vs = gps.filter(x => x.mate), mates = [...new Set(vs.map(x => x.mate.name))];
  const ratings = p.kind === 'driver' || !p.kind ? (p.charId ? f1DevApply(Object.assign({}, F1_ROOKIE, p), p.charId) : p) : null;
  const eng = p.kind === 'engineer' && c ? F1.weekends().filter(w => w.setupBy && Object.values(w.setupBy).indexOf(c.id) !== -1) : [];
  const engQ = eng.map(w => { const code = Object.keys(w.setupBy).find(k => w.setupBy[k] === c.id); return w.setup[code]; });
  return `<div class="page-head"><div><p class="eyebrow">${esc(F1_ROLE[p.kind] || 'Driver')}${team ? ', ' + esc(team.name) : ''}${p.charId ? '' : ', real'}</p><h1>${p.flag ? esc(p.flag) + ' ' : ''}${esc(p.name)}</h1>
      ${c && c.bio ? `<p>${esc(c.bio.slice(0, 300))}</p>` : ''}</div></div>
    ${p.kind === 'engineer' ? `<div class="metrics"><div class="metric"><b>${eng.length}</b><span>Weekends with a set-up locked in</span></div><div class="metric"><b>${engQ.length ? Math.round(engQ.reduce((a, b) => a + b, 0) / engQ.length) : '–'}</b><span>Average set-up found (out of 95)</span></div></div>` : ''}
    ${p.kind !== 'engineer' && p.kind !== 'principal' ? `<div class="metrics"><div class="metric"><b>${gps.length}</b><span>Grands Prix</span></div><div class="metric"><b>${wins}</b><span>Wins</span></div>
      <div class="metric"><b>${pods}</b><span>Podiums</span></div><div class="metric"><b>${pts}</b><span>Points</span></div></div>
    <div class="cols2"><section class="card"><h2>Record</h2><table class="data compact"><tbody>
      <tr><td>Pole positions</td><td class="num">${poles}</td></tr><tr><td>Best finish</td><td class="num">${best < 99 ? 'P' + best : '–'}</td></tr><tr><td>Retirements</td><td class="num">${dnf}</td></tr>
      ${mates.length ? `<tr><td>Against ${esc(mates.join(' and '))} in races</td><td class="num">${vs.filter(x => x.beat).length} to ${vs.filter(x => !x.beat).length}</td></tr>
      <tr><td>Against ${esc(mates.join(' and '))} in qualifying</td><td class="num">${vs.filter(x => x.qbeat).length} to ${vs.filter(x => !x.qbeat).length}</td></tr>` : ''}</tbody></table></section>
      <section class="card"><h2>Ratings</h2>${p.charId ? devPanelHtml(p.charId) : `<table class="data compact"><tbody>${F1_RATINGS.map(([k, l]) => `<tr><td>${esc(l)}</td><td class="num"><b>${esc(ratings[k])}</b></td></tr>`).join('')}</tbody></table>`}</section></div>
    ${rec.length ? `<section class="card"><h2>Race by race</h2><div class="scroll-x"><table class="data"><thead><tr><th>Race</th><th>Team</th><th class="num">Grid</th><th class="num">Finish</th><th class="num">Points</th></tr></thead><tbody>${rec.slice().reverse().map(x => { const t = F1.track(x.w.trackId) || {};
      return `<tr><td>${esc(t.name || '')}${x.w.session === 'sprint' ? ' sprint' : ''}</td><td><span class="f1-bar" style="background:${esc(f1Colour(x.r.teamId))}"></span>${esc(F1.team(x.r.teamId).name)}</td><td class="num">${x.r.grid}</td><td class="num">${x.r.position ? 'P' + x.r.position : 'Out'}</td><td class="num">${x.r.points || ''}</td></tr>`; }).join('')}</tbody></table></div></section>` : '<p class="muted">No races yet.</p>'}` : ''}`;
});

/* ================================================================ Team HQ */
route('team', 'Team HQ', function () {
  const teams = F1.teams(); if (!teams.length) return '<div class="empty">The grid isn’t set up yet.</div>';
  const mySeat = S.charId ? F1.seats().find(s => s.holderCharId === S.charId) : null;
  const tid = S.ui.teamId || (mySeat && mySeat.teamId) || teams[0].id, team = F1.team(tid), n = finishedGps().length;
  const eff = f1EffectiveTeam(team, n), tp = tpSeat(tid);
  const statRow = ([k, l]) => { const d = Math.round(((eff[k] || 0) - (team[k] || 0)) * 100) / 100; return `<tr><td>${esc(l)}</td><td class="num"><b>${eff[k]}</b>${d ? ` <span class="${d > 0 ? 'f1-up' : 'f1-down'}">${d > 0 ? '+' : '−'}${Math.abs(d)}</span>` : ''}</td></tr>`; };
  const drivers = F1.seats(tid).filter(s => s.role === 'driver').map(s => ({ s, o: f1Occupant(s) }));
  return `<div class="page-head"><div><h1>${esc(team.name)}</h1><p>${esc(engineLabel(team.id))}</p></div>
      <label class="field" style="margin:0">Team${sel('team-pick', 'ui/teamId', tid, teams.map(t => [t.id, t.name]))}</label></div>
    <div class="cols2">
      <section class="card" style="--team:${esc(team.color)}"><h2>The car</h2><p class="muted small">For the next race.</p>
        <table class="data compact"><tbody>${[['carPace', 'Overall pace'], ['topSpeed', 'Top speed'], ['cornering', 'Cornering'], ['reliability', 'Reliability'], ['tyreLife', 'Kindness to tyres'], ['pitSpeed', 'Pit crew']].map(statRow).join('')}</tbody></table></section>
      <section class="card"><h2>People</h2><ul class="f1-seatlist">${F1.seats(tid).map(s => { const o = f1Occupant(s);
        return `<li><span class="role">${esc(seatTitle(s))}</span><div class="f1-occ">${o.person ? careerLink(o.person.id, o.name) : esc(o.name)} ${o.player ? '<span class="tag player">Player</span>' : o.person ? '<span class="tag">Real</span>' : ''}${s.role === 'driver' && o.person ? `<span class="muted small">${f1Record(o.person.id).filter(x => wSeries(x.w) === curSeriesId() && wSeason(x.w) === curSeasonId()).reduce((a, x) => a + (x.r.points || 0), 0)} points this season</span>` : ''}</div></li>`; }).join('')}</ul></section></div>
    ${drivers.filter(x => x.o.player && x.s.holderCharId === S.charId).map(x => `<section class="card"><h2>Your development</h2>${devPanelHtml(x.s.holderCharId)}</section>`).join('')}`;
});

/* =====================================================================
   F1 SIM — the race weekend, live.
   Qualifying is revealed a session at a time (Q1, Q2, Q3). Race Control
   can run the race live: press play and a lap is run every few seconds,
   saved, and shown to everyone at once through the live database link.
   The race view is broken down into timing plus tabs for the race log,
   a lap chart, tyre strategy and one driver in detail.
   ===================================================================== */
'use strict';

/* ---------------------------------------------------------------- qualifying, one session at a time */
ACTIONS['f1-quali-next'] = () => {
  const w = F1.live(); if (!w || w.status !== 'quali') return;
  const stage = (w.qualiStage || 1) + 1, doc = Object.assign(clone(S.store.f1_weekends[w.id]), { qualiStage: stage });
  if (stage >= 3) doc.status = 'grid';
  const pole = (w.quali.log || []).find(l => l.kind === 'pole');
  run(async () => { await Data.put('f1_weekends', w.id, doc); if (stage >= 3 && pole) await Data.audit('f1.pole', pole.text); },
    stage >= 3 ? `Q3 is done: ${pole ? pole.text : 'the grid is set'}.` : `Q${stage} is done.`);
};
const qStage = w => w.status === 'quali' ? (w.qualiStage || 1) : 3;
function lvQualiHtml(w) {
  if (w.state.rules.qualifying && w.state.rules.qualifying.q2 >= 99) {
    const res = ((w.quali && w.quali.results) || []).slice().sort((a, b) => (a.times[2] || 999) - (b.times[2] || 999)), fast = res[0] && res[0].times[2];
    return `<table class="data timing"><thead><tr><th>P</th><th>Driver</th><th class="num">Time</th><th class="num">Gap</th></tr></thead><tbody>${res.map((r, i) => { const c = w.state.cars.find(x => x.id === r.id) || { id: r.id };
      return `<tr class="${r.id === S.ui.f1pick ? 'picked' : ''}"><td><b>${i + 1}</b></td><td>${lvDriverBtn(w, c)}</td><td class="num ${i === 0 ? 'fl' : ''}">${f1Fmt(r.times[2])}</td><td class="num">${i ? '+' + (r.times[2] - fast).toFixed(3) : ''}</td></tr>`; }).join('')}</tbody></table>`;
  }
  /* Stage s means Q1..Qs have been run. Only those sessions' times are shown, so nothing later leaks. */
  const s = qStage(w), res = (w.quali && w.quali.results) || [], n = k => k === 'Q1' ? 1 : k === 'Q2' ? 2 : 9;
  const through = res.filter(r => n(r.out) > s).sort((a, b) => (a.times[s - 1] || 999) - (b.times[s - 1] || 999));
  const outs = [];
  for (let k = s; k >= 1; k--) outs.push(...res.filter(r => n(r.out) === k).sort((a, b) => (a.times[k - 1] || 999) - (b.times[k - 1] || 999)));
  const fastest = k => Math.min(...res.map(r => r.times[k]).filter(x => x != null && isFinite(x)));
  const row = (r, i, outIn) => { const c = w.state.cars.find(x => x.id === r.id) || { id: r.id };
    return `<tr class="${outIn ? 'out' : ''} ${r.id === S.ui.f1pick ? 'picked' : ''}"><td><b>${i + 1}</b></td><td>${lvDriverBtn(w, c)}</td>
      ${[0, 1, 2].slice(0, s).map(k => `<td class="num ${r.times[k] != null && r.times[k] === fastest(k) ? 'fl' : ''}">${r.times[k] == null || !isFinite(r.times[k]) ? '' : f1Fmt(r.times[k])}</td>`).join('')}
      <td>${outIn ? `<span class="tag">Out in Q${outIn}</span>` : ''}</td></tr>`; };
  return `<table class="data timing"><thead><tr><th>P</th><th>Driver</th>${[1, 2, 3].slice(0, s).map(k => `<th class="num">Q${k}</th>`).join('')}<th></th></tr></thead><tbody>
    ${through.map((r, i) => row(r, i, null)).join('')}${outs.map((r, i) => row(r, through.length + i, n(r.out) <= 2 ? n(r.out) : null)).join('')}</tbody></table>
    <p class="legend-line muted small"><span class="fl">Purple</span>: fastest in that session.${s < 3 ? ` ${plural(through.length, 'driver')} go through to Q${s + 1}.` : ''}</p>`;
}
/* ---------------------------------------------------------------- live running (Race Control) */
const LIVE_SPEEDS = [['4000', 'Steady: a lap every 4 seconds'], ['2000', 'Normal: a lap every 2 seconds'], ['1000', 'Fast: a lap a second']];
function liveStop(msg) {
  if (!S.f1live) return;
  clearTimeout(S.f1live); S.f1live = null;
  const w = F1.live();
  if (w && w.live) Data.put('f1_weekends', w.id, Object.assign(clone(S.store.f1_weekends[w.id]), { live: false })).catch(() => {});
  if (msg) toast(msg); render();
}
async function liveTick() {
  const w = F1.live();
  if (!S.f1live || !w || !w.state || w.state.finished) { liveStop(); return; }
  if (S.busy) { S.f1live = setTimeout(liveTick, 300); return; }
  /* A driver moment is waiting: give the driver up to 45 seconds unless everyone has answered. */
  if (!raceLocked(w) && pendingMoments(w).length && !momentsAnswered(w) && momentWaitLeft(w) > 0) { S.f1live = setTimeout(liveTick, 1000); render(); return; }
  const log = await f1Advance(1);
  if (!S.f1live) return;
  if (!log) { liveStop('The race is paused: the lap couldn’t be saved.'); return; }
  const now = F1.live();
  if (!now || !now.state || now.state.finished) { S.f1live = null; render(); return; }
  if (S.ui.form.f1stopSc !== false && log.some(l => l.kind === 'red' || ((l.kind === 'sc' || l.kind === 'vsc') && /deployed/.test(l.text)))) { liveStop(log.some(l => l.kind === 'red') ? 'Red flag. The race is stopped: everyone gets fresh tyres and repairs, and it restarts behind the safety car when Race Control carries on.' : 'Safety car. The race is paused so the teams can make their calls.'); return; }
  S.f1live = setTimeout(liveTick, Number(S.ui.form.f1speed || 2000));
}
ACTIONS['f1-moments'] = (d, el) => { S.ui.form.f1moments = !!el.checked; };
ACTIONS['live-play'] = () => { if (S.f1live) { liveStop('Paused.'); return; } S.f1live = setTimeout(liveTick, 50); render(); };

/* ---------------------------------------------------------------- pieces of the race view */
/* The race log; during qualifying it only shows the sessions already run. */
function lvFeedHtml(w) {
  if (w.status !== 'quali') return f1FeedHtml(w);
  const log = (w.quali && w.quali.log) || [], s = w.qualiStage || 1; let seen = 0, upto = log.length;
  for (let i = 0; i < log.length; i++) { if (log[i].kind === 'session') { seen++; if (seen === s) { upto = i + 1; break; } } }
  const shown = log.slice(0, upto).reverse();
  return shown.length ? `<ul class="f1-feed">${shown.map(l => `<li class="${esc(l.kind)}"><span class="l">Q</span><span class="t">${esc(l.text)}</span></li>`).join('')}</ul>` : '<p class="muted">No news from qualifying yet.</p>';
}
/* What's wrong with a car that's still running. */
function lvLimpText(c) { const l = c.limp || {}; return { wing: 'Front wing damage: pitting for a new nose', power: 'Down on power', shift: 'Gearshift problems', braketemp: 'Managing brake temperatures', floor: 'Floor damage', overheat: 'Overheating', bag: 'Debris in a brake duct' }[l.inc] || 'A problem with the car'; }
function lvDriverBtn(w, c) {
  const e = f1Ent(w, c.id), mine = S.charId && e.charId === S.charId;
  return `<button class="drv-btn" data-act="f1-pick" data-id="${esc(c.id)}" aria-pressed="${S.ui.f1pick === c.id}"><span class="f1-bar" style="background:${esc(f1Colour(e.teamId))}"></span><b>${esc(c.id)}</b><span class="full">${esc(e.name)}</span></button>${e.charId ? ' <span class="tag player">Player</span>' : ''}${mine ? ' <span class="tag you">You</span>' : ''}`;
}
ACTIONS['f1-pick'] = d => { S.ui.f1pick = S.ui.f1pick === d.id && S.ui.f1tab === 'driver' ? null : d.id; S.ui.f1tab = S.ui.f1pick ? 'driver' : (S.ui.f1tab === 'driver' ? 'feed' : S.ui.f1tab); render(); };
ACTIONS['f1-tab'] = d => { S.ui.f1tab = d.tab; render(); };
function lvTowerHtml(w) {
  const st = w.state; if (!st.lap) return lvQualiHtml(w);
  const order = f1Order(st), lead = order[0], avg = lead.cum / Math.max(1, st.lap), fast = st.fastest;
  return `<table class="data timing"><thead><tr><th>P</th><th>Driver</th><th class="num">Gap</th><th class="num">Int</th><th>Tyre</th><th class="num">Last lap</th><th class="num">Pits</th></tr></thead><tbody>${order.map((c, i) => {
    const cls = `${c.id === S.ui.f1pick ? 'picked' : ''} ${c.status !== 'running' ? 'out' : ''}`;
    if (c.status !== 'running') return `<tr class="${cls}"><td>–</td><td>${lvDriverBtn(w, c)}</td><td colspan="5" class="muted">Out on lap ${c.retiredLap}: ${esc(c.dnf)}</td></tr>`;
    const gap = c.cum - lead.cum, down = Math.floor(gap / avg), moved = c.grid - (i + 1);
    const lapCls = fast && fast.id === c.id && c.lastLap === fast.time ? 'fl' : c.lastLap && c.lastLap === c.bestLap ? 'pb' : '';
    return `<tr class="${cls}"><td><b>${i + 1}</b>${moved ? ` <span class="${moved > 0 ? 'f1-up' : 'f1-down'}">${moved > 0 ? '▲' : '▼'}${Math.abs(moved)}</span>` : ''}</td><td>${lvDriverBtn(w, c)}${c.pen ? `<span class="tag pen" title="Penalty to serve">+${c.pen}s</span>` : ''}${c.limp ? `<span class="tag dmg" title="${esc(lvLimpText(c))}">${c.limp.fix ? 'Damage' : 'Problem'}</span>` : ''}</td>
      <td class="num">${i === 0 ? 'Leader' : down >= 1 ? `+${down} lap${down > 1 ? 's' : ''}` : '+' + gap.toFixed(1)}</td><td class="num">${i === 0 ? '' : '+' + (c.cum - order[i - 1].cum).toFixed(1)}</td>
      <td>${f1TyreChip(c.tyre.compound, c.tyre.age)}</td><td class="num ${lapCls}">${f1Fmt(c.lastLap)}</td><td class="num">${c.stops}</td></tr>`; }).join('')}</tbody></table>
    <p class="legend-line muted small"><span class="fl">Purple</span>: fastest lap of the race. <span class="pb">Green</span>: a driver’s personal best. Click a driver for their race.</p>`;
}
/* Positions lap by lap: every car a line in its team colour; the picked driver and players stand out. */
function lvLapChartHtml(w) {
  const st = w.state; if (!st.lap) return '<p class="muted">The lap chart starts with the race.</p>';
  const cars = st.cars, N = cars.length, L = Math.max(st.lap, 1), rowH = 18, top = 14, left = 40, right = 44, W = 660, H = top + N * rowH + 18;
  const x = l => left + l / L * (W - left - right), y = p => top + (p - 1) * rowH + rowH / 2;
  const hi = c => c.id === S.ui.f1pick || (!S.ui.f1pick && !!f1Ent(w, c.id).charId);
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Positions lap by lap">`;
  for (let p = 1; p <= N; p++) if (p === 1 || p % 5 === 0) s += `<line x1="${left}" x2="${W - right}" y1="${y(p)}" y2="${y(p)}" stroke="var(--line)"/>`;
  for (let l = 0; l <= L; l += (L > 40 ? 10 : 5)) s += `<text x="${x(l)}" y="${H - 4}" font-size="11" text-anchor="middle" fill="var(--muted)">${l === 0 ? 'Grid' : l}</text>`;
  const draw = c => { const pts = [[0, c.grid]].concat(c.positions.map((p, i) => [i + 1, p])).filter(q => q[1] != null);
    const strong = hi(c), col = f1Colour(f1Ent(w, c.id).teamId);
    let h = `<polyline points="${pts.map(q => `${x(q[0]).toFixed(1)},${y(q[1]).toFixed(1)}`).join(' ')}" fill="none" stroke="${esc(col)}" stroke-width="${strong ? 3.2 : 1.6}" stroke-linejoin="round" opacity="${strong || !S.ui.f1pick ? 1 : 0.28}"/>`;
    const last = pts[pts.length - 1];
    h += `<text x="${x(last[0]) + 6}" y="${y(last[1]) + 4}" font-size="11.5" font-weight="${strong ? 700 : 500}" fill="var(--ink)" opacity="${strong || !S.ui.f1pick ? 1 : 0.45}">${esc(c.id)}</text>`;
    if (c.status !== 'running') h += `<text x="${x(last[0]) + 6}" y="${y(last[1]) + 4}" dx="30" font-size="11" fill="var(--bad)">Out</text>`;
    return h; };
  cars.filter(c => !hi(c)).forEach(c => { s += draw(c); }); cars.filter(hi).forEach(c => { s += draw(c); });
  cars.slice().sort((a, b) => a.grid - b.grid).forEach(c => { s += `<text x="${left - 6}" y="${y(c.grid) + 4}" font-size="11" text-anchor="end" fill="var(--muted)">${esc(c.id)}</text>`; });
  return `<div class="scroll-x f1-chart">${s}</svg></div><p class="muted small">${S.ui.f1pick ? 'Click the driver again in the timing to see everyone.' : 'Players’ drivers are drawn bold. Click a driver in the timing to follow them.'}</p>`;
}
function lvDriverHtml(w) {
  const st = w.state, c = st.cars.find(x => x.id === S.ui.f1pick);
  if (!c) return '<p class="muted">Click a driver in the timing to see their race.</p>';
  const e = f1Ent(w, c.id), order = f1Order(st), pos = order.indexOf(c) + 1, lead = order[0], team = F1.team(e.teamId);
  const life = RaceEngine.tyreLife(c.tyre.compound, c, st.circuit), wear = Math.min(100, Math.round(c.tyre.wear / life * 100));
  const laps = c.lapTimes.map((t, i) => ({ t, lap: i + 1 })).filter(x => x.t != null);
  const clean = laps.filter(x => x.t < (c.bestLap || 999) * 1.07), lo = c.bestLap || 0, hiT = lo + 4;
  const scLaps = new Set(); let on = null;
  st.events.forEach(ev => { if ((ev.kind === 'sc' || ev.kind === 'vsc') && /deployed/.test(ev.text)) on = ev.lap + 1; if ((ev.kind === 'sc' || ev.kind === 'vsc') && /ends/.test(ev.text) && on) { for (let l = on; l <= ev.lap; l++) scLaps.add(l); on = null; } });
  if (on) for (let l = on; l <= st.lap; l++) scLaps.add(l);
  const pits = new Set(c.stints.slice(1).map(s => s.from - 1));
  const span = st.finished ? st.laps : Math.max(st.lap, 12), W = 640, H = 190, bw = (W - 50) / span;
  let bars = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Lap times for ${esc(e.name)}">`;
  laps.forEach(x => { const slow = x.t > hiT, hgt = slow ? H - 30 : Math.max(3, (x.t - lo) / 4 * (H - 30) + 3);
    const col = pits.has(x.lap) ? 'var(--muted)' : scLaps.has(x.lap) ? 'var(--f1-flag)' : x.t === c.bestLap ? 'var(--pb)' : esc(f1Colour(e.teamId));
    bars += `<rect x="${44 + (x.lap - 1) * bw}" y="${H - 18 - hgt}" width="${Math.max(1, bw - 1.5)}" height="${hgt}" fill="${col}" opacity="${slow ? 0.35 : 1}"><title>Lap ${x.lap}: ${f1Fmt(x.t)}</title></rect>`; });
  bars += `<text x="40" y="${H - 18}" font-size="11" text-anchor="end" fill="var(--muted)">${f1Fmt(lo)}</text><text x="40" y="16" font-size="11" text-anchor="end" fill="var(--muted)">+4s</text></svg>`;
  const mine = st.events.filter(ev => (ev.ids || []).indexOf(c.id) !== -1).slice(-12).reverse();
  return `<div class="driver-head" style="--team:${esc(team.color)}"><h3>${careerLink(e.personId, e.name)}</h3><p class="muted">${esc(team.name)}${e.charId ? ', a player' : ''}</p></div>
    <div class="metrics small-metrics"><div class="metric"><b>${c.status === 'running' ? 'P' + pos : 'Out'}</b><span>Started P${c.grid}</span></div>
      <div class="metric"><b>${c.status === 'running' && pos > 1 ? '+' + (c.cum - lead.cum).toFixed(1) : c.status === 'running' ? 'Leader' : esc(c.dnf)}</b><span>${c.status === 'running' ? 'To the leader' : 'Retired on lap ' + c.retiredLap}</span></div>
      <div class="metric"><b>${f1Fmt(c.bestLap)}</b><span>Best lap</span></div><div class="metric"><b>${c.stops}</b><span>${c.stops === 1 ? 'Pit stop' : 'Pit stops'}</span></div></div>
    ${c.status === 'running' ? `<div class="f1-gauges"><div class="f1-gauge">${esc(RaceEngine.COMPOUNDS[c.tyre.compound].label)}s, ${c.tyre.age} laps old: wear ${wear}%<div class="track"><div class="fill ${wear >= 90 ? 'hot' : ''}" style="width:${wear}%"></div></div></div>
      <div class="f1-gauge">${w.state.rules.noHybrid ? 'No battery' : `Battery ${Math.round(c.energy)}%`}, ${esc(RaceEngine.MODES[c.mode].label.toLowerCase())} mode<div class="track"><div class="fill" style="width:${c.energy}%"></div></div></div></div>` : ''}
    <h4>Lap times</h4><div class="scroll-x f1-chart">${bars}</div>
    <p class="muted small">Team colour: a racing lap. Green: their best. Yellow: safety car. Grey: a pit stop. Faded: more than 4 seconds off their best.</p>
    <h4>Stints</h4><p>${c.stints.map(s => `${f1TyreChip(s.compound)} laps ${s.from}${s.to ? '–' + s.to : ' onwards'}`).join(' &nbsp; ')}</p>
    ${mine.length ? `<h4>Their race</h4><ul class="f1-feed short">${mine.map(l => `<li class="${esc(l.kind)}"><span class="l">L${esc(l.lap)}</span><span class="t">${esc(l.text)}</span></li>`).join('')}</ul>` : ''}`;
}
function lvStagesHtml(w) {
  const single = !!(w.state && w.state.rules.qualifying && w.state.rules.qualifying.q2 >= 99) || (!w.state && seriesDoc(wSeries(w)).quali === 'single');
  const stages = single ? ['Practice', 'Qualifying', 'Race', 'Result'] : ['Practice', 'Q1', 'Q2', 'Q3', 'Race', 'Result'];
  let cur = w.status === 'practice' ? 0 : w.status === 'quali' ? (w.qualiStage || 1) : w.status === 'grid' ? 3 : w.status === 'running' ? 4 : 5;
  if (single) cur = w.status === 'practice' ? 0 : w.status === 'grid' ? 1 : w.status === 'running' ? 2 : 3;
  return `<ol class="stages" aria-label="The weekend">${stages.map((s, i) => `<li class="${i < cur ? 'done' : i === cur ? 'now' : ''}" ${i === cur ? 'aria-current="step"' : ''}>${s}</li>`).join('')}</ol>`;
}
function lvControlHtml(w) {
  const st = w.state, calls = f1Calls(w), setups = calls.filter(c => c.type === 'setup').length, pending = calls.length - setups;
  const runs = list('f1_runs').filter(r => r.weekendId === w.id).length;
  if (w.status === 'practice') { const done = endedSessions(w).length, n = curSession(w), all = done >= sessionsOf(w), single = seriesDoc(wSeries(w)).quali === 'single';
    return `<section class="card rc"><h2>Race Control <span class="sub">${all ? 'Practice is over' : esc(sessionName(w, n)) + ' is running'}</span></h2><p>${plural(runs, 'practice run')} done, ${plural(setups, 'set-up')} locked in. Cars without a locked set-up run a standard one. ${fullPractice(w) ? `Full sessions: teams plan their runs, then running the session plays them out with its own weather, red flags, crashes and failures. ${esc(practiceForecastText(w))}` : 'Quick practice: runs report straight away; ending a session posts its timesheet.'} Each player car gets a debrief.</p>
    <div class="btn-row">${all ? '' : `<button class="btn ${all ? '' : 'primary'}" data-act="fp-end">${fullPractice(w) ? 'Run' : 'End'} ${esc(sessionName(w, n))}</button>`}${w.session === 'test' ? `<button class="btn ${all ? 'primary' : ''}" data-act="test-finish">Finish testing</button>` : `<button class="btn ${all ? 'primary' : ''}" data-act="f1-quali">${single ? 'Run qualifying' : 'Run Q1'}${all ? '' : ' now'}</button>`}<button class="btn" data-act="f1-cancel">Cancel the weekend</button></div></section>`; }
  if (w.status === 'quali') return `<section class="card rc"><h2>Race Control</h2><p>Q${w.qualiStage || 1} is done.</p>
    <div class="btn-row"><button class="btn primary" data-act="f1-quali-next">Run Q${(w.qualiStage || 1) + 1}</button><button class="btn" data-act="f1-cancel">Cancel the weekend</button></div></section>`;
  if (w.status === 'finished') return '';
  const live = !!S.f1live;
  return `<section class="card rc ${live ? 'is-live' : ''}"><h2>Race Control ${live ? '<span class="tag live">Live</span>' : ''} <span class="sub">${pending ? plural(pending, 'pit-wall call') + ' waiting' : 'No calls waiting'}</span></h2>
    <div class="btn-row"><button class="btn primary" data-act="live-play">${live ? 'Pause' : st.lap === 0 ? 'Start the race live' : 'Resume live'}</button>
      <label class="sr-only" for="f1-speed">Speed</label>${sel('f1-speed', 'ui/form/f1speed', S.ui.form.f1speed || '2000', LIVE_SPEEDS)}
      <button class="btn" data-act="f1-step" data-laps="1" ${live ? 'disabled' : ''}>${st.lap === 0 ? 'Run lap 1' : 'Next lap'}</button>
      <button class="btn" data-act="f1-step" data-laps="999" ${live ? 'disabled' : ''}>Run to the flag</button>
      <label class="small"><input type="checkbox" data-act="f1-stopsc" ${S.ui.form.f1stopSc !== false ? 'checked' : ''}> Pause when a safety car comes out</label>
      <label class="small"><input type="checkbox" data-act="f1-moments" ${S.ui.form.f1moments !== false ? 'checked' : ''}> Driver moments</label>
      <button class="btn" data-act="f1-cancel" ${live ? 'disabled' : ''}>Cancel the weekend</button></div>
    ${pendingMoments(w).length ? `<p class="small"><b>Driver moment${pendingMoments(w).length > 1 ? 's' : ''}:</b> ${pendingMoments(w).map(m => `${esc(m.carId)} ${momentCall(w, m) ? 'has chosen' : 'is choosing'}`).join(', ')}.${live ? ` The race waits up to ${Math.ceil(momentWaitLeft(w) / 1000)} more seconds.` : ' Running the next lap settles them (the driver’s instinct decides for anyone who hasn’t chosen).'}</p>` : ''}
    <p class="muted small">Live, everyone watches the same laps as they happen, and pit-wall calls apply on the next lap. Keep this page open while it runs.</p></section>`;
}

/* ---------------------------------------------------------------- the Race Weekend screen */
route('weekend', 'Race Weekend', function () {
  const head = (k, t, p, right) => `<div class="page-head"><div>${k ? `<p class="eyebrow">${k}</p>` : ''}<h1>${t}</h1>${p ? `<p>${p}</p>` : ''}</div>${right || ''}</div>`;
  if (!F1.teams().length) return head('', 'Race Weekend', 'The grid isn’t set up yet.') + (S.isGm ? '<div class="card"><p>Load today’s grid on The Grid first.</p><button class="btn primary" data-act="nav" data-route="grid">Go to The Grid</button></div>' : '');
  const past = F1.weekends().filter(w => w.status === 'finished' && w.session !== 'test');
  const view = S.ui.f1view ? get('f1_weekends', S.ui.f1view) : null;
  const w = view || F1.live() || past[0] || null;
  const pastHtml = past.length ? `<section class="card" style="margin-top:16px"><h2>Results so far</h2><div class="scroll-x"><table class="data"><thead><tr><th>Round</th><th>Session</th><th>Winner</th><th></th></tr></thead><tbody>${past.map(x => { const t = F1.track(x.trackId) || {}, win = (x.results || [])[0] || {};
      return `<tr><td>${esc(t.round || '')} ${esc(t.name || x.trackId)}</td><td>${x.session === 'sprint' ? 'Sprint' : 'Grand Prix'}</td><td><span class="f1-bar" style="background:${esc(f1Colour(win.teamId))}"></span>${esc(win.name || '')}</td><td><button class="btn small" data-act="f1-view" data-id="${esc(x.id)}">View</button></td></tr>`; }).join('')}</tbody></table></div></section>` : '';
  if (!w) return head('', 'Race Weekend', S.isGm ? 'Open a weekend. Teams use practice to find their set-ups; qualifying runs a session at a time; the race can run live.' : 'No weekend is open. Race Control opens each one.') + (S.isGm ? f1OpenFormHtml() : '') + pastHtml;

  const t = F1.track(w.trackId) || { name: w.trackId, laps: 0 }, st = w.state, sprint = w.session === 'sprint';
  const laps = st ? st.laps : (sprint ? (t.sprintLaps || Math.ceil(t.laps / 3)) : t.laps);
  const lapLbl = w.status === 'practice' ? 'Practice' : w.status === 'quali' ? 'Qualifying' : !st ? (w.session === 'test' ? 'Testing' : '') : st.finished ? 'Chequered flag' : st.lap === 0 ? 'Grid set' : (w.live ? 'Live, lap' : 'Lap');
  const right = `<div class="f1-lap ${w.live ? 'live' : ''}" aria-live="polite"><small>${lapLbl}</small>${st && w.status !== 'quali' ? `${st.lap}<span class="of">/${laps}</span>` : w.status === 'quali' ? `Q${w.qualiStage || 1}` : ''}</div>`;
  const track = st ? st.track[Math.max(0, st.lap - 1)] : 0;
  const chips = st && st.lap ? `<p class="chips"><span class="tag ${track === 2 ? 'wet' : track === 1 ? 'damp' : ''}">${['Dry', 'Damp', 'Wet'][track]} track</span>${st.sc.type ? ` <span class="tag flag">${st.sc.type === 'sc' ? 'Safety car' : 'Virtual safety car'}</span>` : ''}${st.fastest ? ` <span class="tag">Fastest lap ${esc(st.fastest.id)} ${f1Fmt(st.fastest.time)}</span>` : ''}</p>` : '';
  let h = head(`${w.session === 'test' ? 'Pre-season testing' : `Round ${esc(t.round || '')}${sprint ? ', sprint' : ''}`}`, `${esc(t.flag || '')} ${esc(t.name)}${sprint ? ' Sprint' : w.session === 'test' ? ' testing' : ''}`, `${esc(t.circuit || '')}, ${laps} laps.` + chips, right);
  h += lvStagesHtml(w);
  if (view) h += `<div class="btn-row" style="margin-bottom:12px"><button class="btn" data-act="f1-view">Back to the current weekend</button></div>`;
  if (S.isGm && !view) h += lvControlHtml(w) || '';
  { const done = endedSessions(w); if (done.length && ['practice', 'quali', 'grid'].indexOf(w.status) !== -1) { const last = done[done.length - 1];
    h += `<section class="card"><h2>${esc(sessionName(w, last.n))} timesheet</h2><div class="scroll-x">${timesheetHtml(w, last)}</div>${done.length > 1 ? `<details><summary>Earlier sessions</summary>${done.slice(0, -1).reverse().map(s => `<h4>${esc(sessionName(w, s.n))}</h4><div class="scroll-x">${timesheetHtml(w, s)}</div>`).join('')}</details>` : ''}</section>`; } }
  if (S.isGm && !view && w.status === 'finished') h += `<section class="card"><h2>Race Control</h2><p>This weekend is finished and counts towards the championship.</p><div class="btn-row"><button class="btn" data-act="f1-discord" data-id="${esc(w.id)}">Post the result to Discord</button></div></section>` + f1OpenFormHtml();
  if (!view && w.status !== 'finished') h += f1MomentCardHtml(w) + f1PitWallHtml(w) + f1StrategyCardHtml(w);

  if (w.session === 'test' && w.status === 'finished') return h + testingSummaryHtml(w) + (view ? '' : pastHtml);
  if (!st) {
    const ents = f1Entrants();
    h += `<section class="card"><h2>Entry list</h2><div class="scroll-x"><table class="data"><thead><tr><th>Car</th><th>Driver</th><th>Team</th></tr></thead><tbody>${ents.map(e => `<tr><td><b>${esc(e.id)}</b></td><td>${careerLink(e.personId, e.name)}${e.charId ? ' <span class="tag player">Player</span>' : ''}</td><td><span class="f1-bar" style="background:${esc(f1Colour(e.teamId))}"></span>${esc(F1.team(e.teamId).name)}</td></tr>`).join('')}</tbody></table></div>
      <p class="muted small">The entry list is fixed when Q1 runs, so seat changes after that apply from the next weekend.</p></section>`;
    return h + pastHtml;
  }
  if (w.status === 'finished') {
    const aw = weekendAwards(w), where = `${t.name}${sprint ? ' sprint' : ''}`;
    h += `<section class="card"><h2>Classification</h2><div class="scroll-x">${f1ResultsHtml(w)}</div>
      ${aw.length ? `<h4>Awards</h4><ul class="awards">${aw.map(a => `<li><span class="tag trophy">${esc(a.label)}</span> ${careerLink(a.personId, (F1.person(a.personId) || {}).name || '')}${['pole', 'win', 'dotd'].indexOf(a.key) !== -1 ? ` <button class="btn small ghost" data-act="card-open" data-id="${esc(a.personId)}" data-kind="${a.key}" data-where="${esc(where)}">Card</button>` : ''}</li>`).join('')}</ul>` : ''}</section>` + dotdHtml(w) + weekendStoryHtml(w);
  }
  const racing = st.lap > 0, tab = S.ui.f1tab && (racing || S.ui.f1tab === 'feed') ? S.ui.f1tab : 'feed';
  const tabs = [['feed', 'Race log'], ['lapchart', 'Lap chart'], ['tyres', 'Tyre strategy'], ['driver', S.ui.f1pick ? `Driver: ${S.ui.f1pick}` : 'Driver']].filter(x => racing || x[0] === 'feed');
  const body = tab === 'lapchart' ? lvLapChartHtml(w) : tab === 'tyres' ? f1ChartHtml(w) : tab === 'driver' ? lvDriverHtml(w) : lvFeedHtml(w);
  h += `<div class="f1-main"><section class="card"><h2>${racing ? 'Timing' : w.status === 'quali' ? `Qualifying: Q${w.qualiStage || 1}` : 'Qualifying'}</h2><div class="scroll-x">${lvTowerHtml(w)}</div></section>
    <section class="card"><div class="tabs" role="tablist">${tabs.map(([k, l]) => `<button role="tab" class="tab" data-act="f1-tab" data-tab="${k}" aria-selected="${tab === k}">${esc(l)}</button>`).join('')}</div>${body}</section></div>`;
  return h + (view ? '' : pastHtml);
});

/* =====================================================================
   F1 SIM — character applications and rolled driver ratings.
   A character starts as a draft. Drivers choose a background, roll their
   ratings (two re-rolls; the latest roll stands), arrange the five
   numbers across the five ratings, choose a driving style, and send the
   application. Race Control sees every roll and approves it (which
   writes the ratings to the driver record the race uses) or returns it
   with a note. Rolls are worked out from the character and the roll
   number, so the same roll always gives the same numbers, and approval
   recalculates them rather than trusting what the application says.
   ===================================================================== */
'use strict';

const ROLL_ATTRS = [['pace', 'Pace'], ['consistency', 'Consistency'], ['wet', 'Wet weather'], ['overtaking', 'Overtaking'], ['defense', 'Defence']];
const MAX_ROLLS = 3;          // the first roll and two re-rolls
const maxRolls = c => MAX_ROLLS + ((c && c.gen && c.gen.extra) || 0);   /* Race Control can give extra re-rolls */
const ROLL_CAP = 90;          // nobody arrives better than 90: the rest is earned
const BRACKETS = [
  { id: 'f2', name: 'Formula 2 graduate', blurb: 'Quick and well drilled, straight up the ladder.', base: 70, dice: [2, 10], exp: 30, mods: {} },
  { id: 'prodigy', name: 'Karting prodigy', blurb: 'Skipped a step. Could be brilliant, could be raw.', base: 63, dice: [3, 10], exp: 15, mods: {} },
  { id: 'convert', name: 'IndyCar or endurance convert', blurb: 'Hardened wheel-to-wheel racer, new to these cars.', base: 68, dice: [2, 10], exp: 55, mods: { overtaking: 3, defense: 3, pace: -2 } },
  { id: 'current', name: 'Current driver', blurb: 'Already on the grid. Proven over full seasons: knows the circuits, the car and the pressure.', base: 72, dice: [2, 8], exp: 60, mods: { consistency: 2, defense: 2 } },
  { id: 'reserve', name: 'Team reserve driver', blurb: 'Knows the car from the simulator. Steady rather than spectacular.', base: 71, dice: [2, 8], exp: 40, mods: { consistency: 3 } },
  { id: 'veteran', name: 'Returning veteran', blurb: 'Been here before. Not the fastest any more, but rarely wrong.', base: 66, dice: [2, 10], exp: 75, mods: { consistency: 4, wet: 2, pace: -3 } }
];
/* Years in racing: more years, more experience; younger drivers earn development points faster. */
const YEARS = [
  { id: '1-2', label: '1 to 2 years', min: 1, max: 2, growth: 1.5, note: 'Raw. Little experience, but they develop half as fast again.' },
  { id: '3-6', label: '3 to 6 years', min: 3, max: 6, growth: 1, note: 'Established. A solid base of experience.' },
  { id: '7+', label: '7 years or more', min: 7, max: 12, growth: 0.75, note: 'Seasoned. Lots of experience and composure, but slower to develop.' }];
const BRACKET_YEARS = { f2: ['1-2', '3-6'], prodigy: ['1-2', '3-6'], convert: ['3-6', '7+'], current: ['3-6', '7+'], reserve: ['1-2', '3-6', '7+'], veteran: ['7+'] };
const BRACKET_EXP = { f2: 0, prodigy: -5, convert: 8, current: 5, reserve: 3, veteran: 6 };
const yearsOf = id => YEARS.find(y => y.id === id) || null;
const bracketOf = id => BRACKETS.find(b => b.id === id) || null;
const charStatus = c => c.status || (F1.person(f1PcId(c.id)) ? 'approved' : 'draft');
const charApproved = c => !!c && charStatus(c) === 'approved';
const STATUS_TEXT = { draft: 'Draft', pending: 'Waiting for Race Control', approved: 'Approved', returned: 'Returned with notes' };

/* Roll k for a character: base plus dice for each of the five ratings, plus mental strength (1d6 + 3). */
function rollValues(charId, k, bracketId) {
  const b = bracketOf(bracketId); if (!b || !k) return null;
  const c0 = get('characters', charId), salt = (c0 && c0.gen && c0.gen.salt) || 0;   /* a reset gives fresh numbers */
  const r = RaceEngine.rng(salt ? h32(charId, 'roll', k, 's' + salt) : h32(charId, 'roll', k)), d = () => { let s = 0; for (let i = 0; i < b.dice[0]; i++) s += 1 + Math.floor(r() * b.dice[1]); return s; };
  const out = { values: ROLL_ATTRS.map(() => Math.min(ROLL_CAP, b.base + d())), mental: 4 + Math.floor(r() * 6) };
  /* Years and experience have their own dice, so adding them didn't change anyone's earlier rolls. */
  const c = get('characters', charId), y = yearsOf(c && c.gen && c.gen.years);
  if (y) { const ry = RaceEngine.rng(salt ? h32(charId, 'years', k, 's' + salt) : h32(charId, 'years', k)); out.years = y.min + Math.floor(ry() * (y.max - y.min + 1));
    out.experience = Math.max(15, Math.min(88, 15 + out.years * 7 + Math.floor(ry() * 8) + (BRACKET_EXP[bracketId] || 0))); }
  return out;
}
const validOrder = o => Array.isArray(o) && o.length === ROLL_ATTRS.length && o.slice().sort().join() === ROLL_ATTRS.map((x, i) => i).join();
/* The finished ratings: the latest roll, arranged, plus the background's adjustments. */
function rolledRatings(c) {
  const g = c.gen || {}, b = bracketOf(g.bracket), roll = rollValues(c.id, Math.min(g.rolls || 0, maxRolls(c)), g.bracket); if (!b || !roll) return null;
  const order = validOrder(g.order) ? g.order : ROLL_ATTRS.map((x, i) => i), y = yearsOf(g.years);
  const out = { experience: roll.experience != null ? roll.experience : b.exp, mental: Math.min(10, roll.mental + (g.years === '7+' ? 1 : 0)), style: g.style || 'technical' };
  if (roll.years != null) { out.years = roll.years; out.growth = y.growth; }
  ROLL_ATTRS.forEach(([k], i) => { out[k] = Math.max(40, Math.min(ROLL_CAP, roll.values[order[i]] + (b.mods[k] || 0))); });
  return out;
}

/* ---------------------------------------------------------------- the player's side */
function charDoc(id) { return clone(S.store.characters[id]); }
function saveGen(c, patch, msg) {
  const doc = charDoc(c.id); doc.gen = Object.assign({}, doc.gen || {}, patch); doc.updatedAt = nowIso();
  return run(async () => { await Data.put('characters', c.id, doc); }, msg);
}
const editable = c => ['draft', 'returned'].indexOf(charStatus(c)) !== -1 && (c.userId === S.uid || S.isGm);
ACTIONS['char-open'] = d => { S.ui.charEdit = d.id; go('character'); };
ACTIONS['gen-bracket'] = d => { const c = get('characters', S.ui.charEdit); if (!c || !editable(c) || (c.gen && c.gen.rolls)) return; const ok = BRACKET_YEARS[d.id] || []; saveGen(c, { bracket: d.id, years: ok.indexOf((c.gen || {}).years) !== -1 ? c.gen.years : (ok.length === 1 ? ok[0] : null) }); };
ACTIONS['gen-years'] = d => { const c = get('characters', S.ui.charEdit); if (!c || !editable(c) || (c.gen && c.gen.rolls)) return; if ((BRACKET_YEARS[(c.gen || {}).bracket] || []).indexOf(d.id) === -1) return; saveGen(c, { years: d.id }); };
ACTIONS['gen-roll'] = () => {
  const c = get('characters', S.ui.charEdit); if (!c || !editable(c)) return;
  const g = c.gen || {}; if (!g.bracket) { toast('Choose a background first.', true); return; }
  if (!g.years) { toast('Choose how many years they’ve been racing first.', true); return; }
  if ((g.rolls || 0) >= maxRolls(c)) { toast('No re-rolls left.', true); return; }
  const n = (g.rolls || 0) + 1;
  saveGen(c, { rolls: n, order: ROLL_ATTRS.map((x, i) => i), rolledAt: (g.rolledAt || []).concat(nowIso()) }, n === 1 ? 'Rolled. Arrange the numbers, or re-roll.' : `Re-rolled. ${plural(maxRolls(c) - n, 're-roll')} left; this roll now stands.`);
};
ACTIONS['gen-move'] = d => {
  const c = get('characters', S.ui.charEdit); if (!c || !editable(c)) return;
  const o = validOrder((c.gen || {}).order) ? c.gen.order.slice() : ROLL_ATTRS.map((x, i) => i), i = Number(d.i), j = i + Number(d.dir);
  if (j < 0 || j >= o.length) return; [o[i], o[j]] = [o[j], o[i]]; saveGen(c, { order: o });
};
CHANGES['gen-style'] = (v) => { const c = get('characters', S.ui.charEdit); if (c && editable(c)) saveGen(c, { style: v }); };
ACTIONS['gen-submit'] = () => {
  const c = get('characters', S.ui.charEdit); if (!c || !editable(c)) return;
  if (c.role === 'driver' && !rolledRatings(c)) { toast('Roll your driver’s ratings first.', true); return; }
  if (!String(c.bio || '').trim()) { toast('Add a few lines about who they are first (Edit details).', true); return; }
  const doc = charDoc(c.id); doc.status = 'pending'; doc.submittedAt = nowIso();
  run(async () => { await Data.put('characters', c.id, doc); }, 'Application sent to Race Control.');
};

/* ---------------------------------------------------------------- Race Control's side */
ACTIONS['gen-approve'] = d => {
  const c = get('characters', d.id); if (!c) return;
  const ratings = c.role === 'driver' ? rolledRatings(c) : {};
  if (c.role === 'driver' && !ratings) { toast('This driver hasn’t rolled their ratings.', true); return; }
  const pid = f1PcId(c.id), cur = F1.person(pid) ? clone(S.store.f1_people[pid]) : {};
  const person = Object.assign({}, c.role === 'driver' ? F1_ROOKIE : {}, cur, ratings, { kind: c.role === 'principal' || c.role === 'engineer' ? c.role : c.role === 'driver' ? 'driver' : c.role,
    charId: c.id, name: c.name, abbr: c.code || f1Code(c.name), num: c.number || null, flag: cur.flag || '', approved: true, bracket: (c.gen || {}).bracket || null, approvedAt: nowIso() });
  run(async () => {
    await Data.put('f1_people', pid, person);
    await Data.put('characters', c.id, Object.assign(charDoc(c.id), { status: 'approved', decidedAt: nowIso(), rcNote: null }));
    await Data.audit('character.approve', `${c.name} approved as ${charRoleName(c.role).toLowerCase()}${c.role === 'driver' ? ` (pace ${ratings.pace}, consistency ${ratings.consistency})` : ''}`);
  }, `${c.name} is approved.`);
};
ACTIONS['gen-return'] = d => {
  const c = get('characters', d.id); if (!c) return; const note = String(((S.ui.form.rcnote || {})[d.id]) || '').trim();
  if (!note) { toast('Say what needs changing, in the note box.', true); return; }
  run(async () => { await Data.put('characters', c.id, Object.assign(charDoc(c.id), { status: 'returned', decidedAt: nowIso(), rcNote: note })); await Data.audit('character.return', `${c.name} returned: ${note}`); }, 'Returned to the player with your note.');
};
function rollHistoryHtml(c) {
  const g = c.gen || {}, rows = [];
  for (let k = 1; k <= Math.min(g.rolls || 0, maxRolls(c)); k++) { const r = rollValues(c.id, k, g.bracket); rows.push(`<tr${k === g.rolls ? ' class="me"' : ''}><td>Roll ${k}${k === g.rolls ? ' (stands)' : ''}</td>${r.values.map(v => `<td class="num">${v}</td>`).join('')}<td class="num">${r.mental}</td></tr>`); }
  return rows.length ? `<table class="data compact"><thead><tr><th></th>${ROLL_ATTRS.map(() => '<th class="num">Value</th>').join('')}<th class="num">Mental</th></tr></thead><tbody>${rows.join('')}</tbody></table>` : '<p class="muted small">No rolls yet.</p>';
}
function ratingsTableHtml(r) {
  return `<table class="data compact"><tbody>${r.years != null ? `<tr><td>Years of experience</td><td class="num"><b>${r.years}</b></td></tr>` : ''}${ROLL_ATTRS.concat([['experience', 'Experience'], ['mental', 'Mental strength (1 to 10)']]).map(([k, l]) => `<tr><td>${esc(l)}</td><td class="num"><b>${r[k]}</b></td></tr>`).join('')}
    <tr><td>Driving style</td><td class="num">${esc((F1_STYLES.find(s => s[0] === r.style) || ['', r.style])[1])}</td></tr></tbody></table>`;
}
function chargenQueueHtml() {
  const pend = list('characters').filter(c => !c.retired && charStatus(c) === 'pending').sort((a, b) => String(a.submittedAt).localeCompare(String(b.submittedAt)));
  return `<section><h2 class="section-h">Character applications ${pend.length ? `<span class="count">${pend.length}</span>` : ''}</h2>
    ${pend.length ? `<div class="cards">${pend.map(c => { const b = bracketOf((c.gen || {}).bracket), r = c.role === 'driver' ? rolledRatings(c) : null;
      return `<article class="card">${c.portraitUrl ? `<img class="app-photo" src="${esc(c.portraitUrl)}" alt="${esc(c.name)}">` : ''}<h3>${esc(c.name)}</h3><p class="small">${c.faceclaim ? `Face claim: <b>${esc(c.faceclaim)}</b>` : '<span class="tag flag">No face claim given</span>'}${c.portraitUrl ? '' : ' <span class="tag flag">No picture</span>'}</p>${PREF_ROLES.indexOf(c.role) !== -1 ? `<p class="small">${prefLine(c) ? esc(prefLine(c)) : '<span class="muted">No team preference given.</span>'}</p>` : ''}<p class="muted small">${esc(charRoleName(c.role))}${c.nationality ? ', ' + esc(c.nationality) : ''}${c.code ? ', ' + esc(c.code) : ''}${c.number ? ' #' + esc(c.number) : ''}. Sent ${esc(fmtWhen(c.submittedAt))}.</p>
        ${paras(c.bio)}
        ${careerRows(c).length ? `<h4>Career record</h4>${careerTableHtml(careerRows(c), { review: c.id })}<p class="muted small">Mark any season you won’t accept as not canon; approving makes the rest canon.</p>` : ''}
        ${r ? `<p><b>${esc(b.name)}</b>. ${esc(b.blurb)}</p>${ratingsTableHtml(r)}<details><summary>Every roll</summary>${rollHistoryHtml(c)}<p class="muted small">Rolls are worked out from the character, so these are exactly what the player saw.</p></details>` : ''}
        <label class="field">Note to the player (needed to return it)<textarea id="rcn-${esc(c.id)}" rows="2" data-bind="ui/form/rcnote/${esc(c.id)}"></textarea></label>
        <label class="small"><input type="checkbox" data-bind="ui/form/postAccept/${esc(c.id)}" ${((S.ui.form.postAccept || {})[c.id]) !== false ? 'checked' : ''}> Post the acceptance card to Discord${c.discord ? `, mentioning @${esc(c.discord)}` : ' (no Discord username, so no @mention)'}</label>
        <div class="btn-row"><button class="btn primary" data-act="gen-approve" data-id="${esc(c.id)}">Approve</button><button class="btn" data-act="gen-return" data-id="${esc(c.id)}">Return with the note</button>${c.role === 'driver' ? `<button class="btn" data-act="gen-extra" data-id="${esc(c.id)}">Give an extra re-roll</button><button class="btn" data-act="gen-reset" data-id="${esc(c.id)}">Reset the ratings</button>` : ''}</div></article>`; }).join('')}</div>`
      : '<p class="muted">No characters waiting.</p>'}</section>`;
}

/* ---------------------------------------------------------------- the character page */
const WEEKEND_MAP = [
  ['Pace', 'Your raw speed: every lap, in practice, qualifying and the race. The biggest single number after the car.'],
  ['Consistency', 'How much your lap times scatter. High consistency means fewer slow laps and tighter qualifying runs.'],
  ['Wet weather', 'Extra pace (or lost pace) whenever the track is damp or wet, and an edge in wet wheel-to-wheel fights.'],
  ['Overtaking', 'Your chance of making a pass stick when you’re close behind someone.'],
  ['Defence', 'How hard you are to pass. It’s set against the attacker’s overtaking every time.'],
  ['Experience', 'Fewer mistakes under pressure, and clearer feedback to your engineer in practice. It grows with every second Grand Prix you start.'],
  ['Mental strength', 'Fewer mistakes when it matters: starts, wet races, battles.'],
  ['Driving style', 'Small nudges: qualifiers find a little extra over one lap, smooth drivers are kinder to tyres, technical drivers help the set-up, aggressive ones take more risks.']
];
function weekendGuideHtml() {
  return `<section class="card"><h2>How your driver plays out on a race weekend</h2><ol class="journey">
    <li><b>Approval.</b> Race Control approves the application, and your ratings become your driver’s record. That record is what every session uses.</li>
    <li><b>A seat.</b> Apply for an open seat on The Grid, or Race Control puts you in one. You then race in place of that team’s real driver, in that team’s car.</li>
    <li><b>Practice.</b> Your race engineer (or you, if no player engineers your car) uses four runs. You describe what the car is doing; the more experienced you are, the clearer that feedback. The set-up they lock in is worth up to three tenths a lap.</li>
    <li><b>Qualifying.</b> One flying lap in each session: the car, your pace, the set-up, and a little luck from your consistency.</li>
    <li><b>The race.</b> Every lap uses your ratings: pace for speed, consistency for scatter, overtaking and defence in every fight, experience and mental strength for mistakes. From the pit wall you choose push, standard or manage, call your own stops, and can refuse a team order.</li>
    <li><b>Over the season.</b> You earn 2 development points for every 3 Grands Prix you start, up to a cap each season. Spend them in Team HQ to raise your ratings by 0.8 per point. Above 80 and 90, each point costs more.</li></ol>
    <table class="data compact"><tbody>${WEEKEND_MAP.map(([k, v]) => `<tr><td class="nowrap"><b>${esc(k)}</b></td><td>${esc(v)}</td></tr>`).join('')}</tbody></table></section>`;
}
route('character', 'Character', function () {
  const c = get('characters', S.ui.charEdit);
  if (!c || (c.userId !== S.uid && !S.isGm)) return '<div class="empty">Choose a character from Your characters.</div>';
  const st = charStatus(c), ed = editable(c), g = c.gen || {}, b = bracketOf(g.bracket), driver = c.role === 'driver', r = driver ? rolledRatings(c) : null;
  const roll = driver && g.rolls ? rollValues(c.id, g.rolls, g.bracket) : null, order = validOrder(g.order) ? g.order : ROLL_ATTRS.map((x, i) => i);
  const steps = [['Who they are', !!String(c.bio || '').trim()], ['Picture and face claim', !!(c.portraitUrl && String(c.faceclaim || '').trim())], ...(driver ? [['Background', !!b], ['Years', !!g.years], ['Roll and arrange', !!g.rolls]] : []), ...(PREF_ROLES.indexOf(c.role) !== -1 ? [['Team', prefDone(c)]] : []), ['Race Control', st === 'approved']];
  let h = `<div class="page-head"><div><p class="eyebrow">${esc(charRoleName(c.role))}</p><h1>${esc(c.name)}</h1><p><span class="tag ${st === 'approved' ? 'player' : st === 'pending' ? 'open' : st === 'returned' ? 'flag' : ''}">${esc(STATUS_TEXT[st])}</span></p></div>
      <div class="btn-row"><button class="btn" data-act="char-edit-inline" data-id="${esc(c.id)}" ${S.ui.charInline === c.id ? 'disabled' : ''}>Edit details</button><button class="btn" data-act="sheet-open" data-id="${esc(c.id)}">Export</button><button class="btn ghost" data-act="nav" data-route="characters">All characters</button></div></div>
    <ol class="stages" aria-label="Application">${steps.map(([l, done], i) => `<li class="${done ? 'done' : (steps.findIndex(s => !s[1]) === i ? 'now' : '')}">${esc(l)}</li>`).join('')}</ol>`;
  if (st === 'returned' && c.rcNote) h += `<div class="card notice warn"><b>Race Control’s note:</b> ${esc(c.rcNote)}</div>`;
  h += offersHtml(c.id);
  if (S.ui.charInline === c.id) h += charInlineHtml(c);
  else h += `<section class="card"><h2>Who they are</h2>${c.personality ? `<h3 class="wt-h">Personality</h3>${paras(c.personality)}` : ''}${c.bio ? `${c.personality ? '<h3 class="wt-h">Backstory</h3>' : ''}${paras(c.bio)}` : '<p class="muted">No backstory written yet. Use Edit details.</p>'}
    <p class="muted small">${[c.nationality, c.code, c.number ? '#' + c.number : '', c.faceclaim ? 'Face claim: ' + c.faceclaim : '', c.discord ? 'Discord: ' + c.discord : ''].filter(Boolean).map(esc).join('. ')}</p>${c.portraitUrl ? `<img class="app-photo" src="${esc(c.portraitUrl)}" alt="${esc(c.name)}">` : ''}</section>`;
  if (S.ui.charInline !== c.id) h += flavourCardHtml(c, 'Flavour');
  h += careerAppHtml(c);
  if (driver) {
    h += `<section class="card"><h2>Background</h2>${g.rolls ? `<p><b>${esc(b.name)}</b>. ${esc(b.blurb)}</p>` : `<p class="muted">Where your driver comes from sets their starting range and experience. It’s fixed once you roll.</p>
      <div class="cards brackets">${BRACKETS.map(x => `<button class="card bracket ${g.bracket === x.id ? 'on' : ''}" data-act="gen-bracket" data-id="${x.id}" aria-pressed="${g.bracket === x.id}" ${ed ? '' : 'disabled'}>
        <b>${esc(x.name)}</b><span>${esc(x.blurb)}</span><span class="muted small">Ratings ${x.base + x.dice[0]} to ${Math.min(ROLL_CAP, x.base + x.dice[0] * x.dice[1])}; ${esc((BRACKET_YEARS[x.id] || []).map(y => yearsOf(y).label.replace(' years', '').replace(' or more', '+')).join(', '))} years${Object.keys(x.mods).length ? '. ' + Object.keys(x.mods).map(k => `${x.mods[k] > 0 ? '+' : '−'}${Math.abs(x.mods[k])} ${k === 'defense' ? 'defence' : k}`).join(', ') : ''}</span></button>`).join('')}</div>`}</section>`;
    if (b) { const ok = BRACKET_YEARS[b.id] || [], y = yearsOf(g.years);
      h += `<section class="card"><h2>Years in racing</h2>${g.rolls ? `<p><b>${esc(y ? y.label : 'Not chosen')}</b>${r && r.years != null ? `: rolled <b>${r.years}</b> years, experience ${r.experience}` : ''}. ${esc(y ? y.note : '')}</p>`
        : `<p class="muted">How long they’ve been racing. The exact number of years, and the experience rating that comes with it, are rolled with the ratings. Fixed once you roll.</p>
        <div class="cards brackets">${ok.map(id => { const x = yearsOf(id); return `<button class="card bracket ${g.years === id ? 'on' : ''}" data-act="gen-years" data-id="${id}" aria-pressed="${g.years === id}" ${ed ? '' : 'disabled'}><b>${esc(x.label)}</b><span>${esc(x.note)}</span>
          <span class="muted small">Development points ×${x.growth}</span></button>`; }).join('')}</div>`}</section>`; }
    if (b) h += `<section class="card"><h2>Ratings</h2>
      ${!g.rolls ? `<p>Roll five numbers for pace, consistency, wet weather, overtaking and defence, plus mental strength. You get ${maxRolls(c) - 1} re-rolls; the latest roll always stands. Then arrange the five numbers across the ratings however you like.</p>`
        : `<p class="muted small">Roll ${g.rolls} of ${maxRolls(c)}${g.rolls < maxRolls(c) ? `: ${plural(maxRolls(c) - g.rolls, 're-roll')} left, and a re-roll replaces this one` : ''}. Use the arrows to move numbers between ratings; the background’s adjustments are added on top.</p>
        <table class="data arrange"><tbody>${ROLL_ATTRS.map(([k, l], i) => `<tr><td>${esc(l)}</td><td class="num"><b>${roll.values[order[i]]}</b>${b.mods[k] ? ` <span class="${b.mods[k] > 0 ? 'f1-up' : 'f1-down'}">${b.mods[k] > 0 ? '+' : '−'}${Math.abs(b.mods[k])}</span>` : ''}</td><td class="num">= <b>${r[k]}</b></td>
          <td class="num">${ed ? `<button class="btn small" data-act="gen-move" data-i="${i}" data-dir="-1" aria-label="Move ${esc(l)}’s number up" ${i === 0 ? 'disabled' : ''}>▲</button> <button class="btn small" data-act="gen-move" data-i="${i}" data-dir="1" aria-label="Move ${esc(l)}’s number down" ${i === ROLL_ATTRS.length - 1 ? 'disabled' : ''}>▼</button>` : ''}</td></tr>`).join('')}
          <tr><td>Experience</td><td></td><td class="num">= <b>${r.experience}</b></td><td class="muted small num">${r.years != null ? `${r.years} years of racing` : 'From the background'}</td></tr>
          <tr><td>Mental strength</td><td></td><td class="num">= <b>${r.mental}</b></td><td class="muted small num">Rolled, 4 to 9</td></tr></tbody></table>
        <label class="field" style="max-width:320px;margin-top:12px">Driving style<select id="gen-style" data-change="gen-style" ${ed ? '' : 'disabled'}>${F1_STYLES.map(([k, l]) => `<option value="${k}" ${(g.style || 'technical') === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>`}
      ${ed ? `<div class="btn-row"><button class="btn ${g.rolls ? '' : 'primary'}" data-act="gen-roll" ${g.rolls >= maxRolls(c) ? 'disabled' : ''}>${g.rolls ? `Re-roll (${maxRolls(c) - g.rolls} left)` : 'Roll the ratings'}</button></div>` : ''}
      ${g.rolls > 1 ? `<details><summary>Earlier rolls</summary>${rollHistoryHtml(c)}</details>` : ''}</section>`;
  }
  h += teamPrefHtml(c);
  if (ed) h += `<section class="card"><h2>Send to Race Control</h2><p>Race Control reads the application${driver ? ' and sees every roll' : ''}, then approves it or sends it back with a note. ${driver ? 'Once approved, you can apply for a seat.' : 'Once approved, you can apply for a seat or take part in the paddock.'}</p>
    <div class="btn-row"><button class="btn primary" data-act="gen-submit">Send the application</button></div></section>`;
  if (st === 'pending') h += `<section class="card"><h2>With Race Control</h2><p>Sent ${esc(fmtWhen(c.submittedAt))}. You’ll see the result here and on Home.</p></section>`;
  if (st === 'approved' && driver) { const p = F1.person(f1PcId(c.id)); if (p) h += `<section class="card"><h2>Your driver’s record</h2>${ratingsTableHtml(f1DevApply(Object.assign({}, F1_ROOKIE, p), c.id))}
    <div class="btn-row"><button class="btn" data-act="career" data-id="${esc(p.id)}">Profile</button>${charSeat(c.id) ? '<button class="btn" data-act="nav" data-route="team">Team HQ</button>' : '<button class="btn primary" data-act="nav" data-route="grid">Find an open seat</button>'}</div></section>`; }
  if (driver) h += weekendGuideHtml();
  return h;
});

/* =====================================================================
   F1 SIM — race strategy.
   For every car, its team principal, race engineer and driver can build
   three plans: the starting tyre, up to three stops (lap and tyre), when
   to go onto wet tyres if it rains and back onto slicks as it dries, and
   whether to take a cheap stop under a safety car. One plan is chosen for
   the start; any of them can be switched to during the race from the
   pit wall. Whoever saved last decides, and everyone in the team sees who.
   ===================================================================== */
'use strict';

const PLAN_NAMES = ['Plan A', 'Plan B', 'Plan C'];
const WET_CALLS = [['early', 'Straight away, at the first spots'], ['normal', 'After a lap of rain'], ['late', 'Gamble: stay on slicks until it’s properly wet']];
const DRY_CALLS = [['early', 'Straight away, on the first dry lap'], ['normal', 'After a dry lap'], ['late', 'Carefully: after a few dry laps']];
const DRY_TYRES = [['soft', 'Softs'], ['medium', 'Mediums'], ['hard', 'Hards']];

/* Who may plan a car: the team principal, the car's race engineer, the car's driver. */
function canPlan(w, ent, charId) {
  if (!ent || !charId) return false;
  const seats = F1.seats(ent.teamId).filter(s => s.holderCharId === charId);
  return seats.some(s => s.role === 'principal' || ((s.role === 'engineer' || s.role === 'driver') && s.car === ent.car));
}
const raceLaps = w => { const t = F1.track(w.trackId) || {}; return w.state ? w.state.laps : (w.session === 'sprint' ? (t.sprintLaps || Math.ceil((t.laps || 50) / 3)) : (t.laps || 50)); };
function cleanPlan(p, laps) {
  p = p || {};
  const dryOk = k => ['soft', 'medium', 'hard'].indexOf(k) !== -1;
  const stops = (p.stops || []).map(s => ({ lap: Math.round(Number(s.lap)), compound: dryOk(s.compound) ? s.compound : 'medium' }))
    .filter(s => s.lap >= 2 && s.lap <= laps - 1).sort((a, b) => a.lap - b.lap).slice(0, 3);
  return { start: dryOk(p.start) ? p.start : 'medium', stops,
    wetCall: ['early', 'normal', 'late'].indexOf(p.wetCall) !== -1 ? p.wetCall : 'normal',
    dryCall: ['early', 'normal', 'late'].indexOf(p.dryCall) !== -1 ? p.dryCall : 'normal', useSC: p.useSC !== false };
}
/* The plans that count for a car: the latest saved by someone allowed to plan it. */
function f1Plan(w, ent) {
  return list('f1_plans').filter(p => p.weekendId === w.id && p.carId === ent.id && canPlan(w, ent, p.charId))
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))[0] || null;
}
function weekendEnt(w, carId) { return (w.entrants || f1Entrants()).find(e => e.id === carId) || null; }

/* Tyre life the team knows about: measured on long runs in practice, or a rough guide from the circuit. */
function tyreKnowledge(w, ent) {
  const track = F1.track(w.trackId), circuit = FormulaRacingAdapter.toCircuit(track), out = {};
  const full = Object.assign({}, ent, { v3: ent.v3 || (f1Entrants().find(x => x.id === ent.id) || {}).v3 });
  f1Runs(w, ent.id).filter(r => r.kind === 'long').forEach(r => { const x = f1RunResult(w, full, r); if (!x.life) return; out[x.compound] = { laps: x.life, measured: true }; });
  ['soft', 'medium', 'hard'].forEach(k => { if (!out[k]) out[k] = { laps: Math.round(RaceEngine.COMPOUNDS[k].life / (circuit.tyreStress || 1)), measured: false }; });
  return out;
}
function suggestPlans(w, ent) {
  const N = raceLaps(w), L = tyreKnowledge(w, ent), clampLap = x => Math.max(2, Math.min(N - 2, Math.round(x)));
  const one = clampLap(Math.min(L.medium.laps * 0.95, Math.max(N * 0.35, N - L.hard.laps * 0.9)));
  return [
    { start: 'medium', stops: [{ lap: one, compound: 'hard' }], wetCall: 'normal', dryCall: 'normal', useSC: true },
    { start: 'soft', stops: [{ lap: clampLap(Math.min(L.soft.laps * 0.9, N * 0.3)), compound: 'medium' }, { lap: clampLap(N * 0.64), compound: 'medium' }], wetCall: 'early', dryCall: 'early', useSC: true },
    { start: 'hard', stops: [{ lap: clampLap(Math.min(L.hard.laps * 0.95, N * 0.6)), compound: 'medium' }], wetCall: 'late', dryCall: 'normal', useSC: false }
  ];
}
/* What a plan looks like, and what's wrong with it. */
function planNotes(p, N, L) {
  const stints = [], notes = []; let from = 1, tyre = p.start;
  p.stops.concat([{ lap: N, compound: null }]).forEach(s => { stints.push({ tyre, from, to: s.lap }); from = s.lap + 1; tyre = s.compound; });
  stints.forEach(s => { const len = s.to - s.from + 1, life = L[s.tyre] ? L[s.tyre].laps : 99;
    if (len > life * 1.1) notes.push(`${len} laps on ${s.tyre}s is longer than they last here (about ${life}). Expect a forced early stop.`); });
  if (new Set(stints.map(s => s.tyre)).size < 2) notes.push('Only one dry tyre: the rules need two, so the car will be made to stop near the end.');
  return { stints, notes };
}
function forecastText(w) {
  const t = F1.track(w.trackId) || {}, st = raceSettings(w), rate = r => r >= 3 ? 'far more likely than usual' : r >= 2 ? 'more likely than usual' : r <= 0.5 ? 'less likely than usual' : '';
  const extra = [st.scRate !== 1 ? `Safety cars ${rate(st.scRate)}.` : '', st.failRate !== 1 ? `Mechanical failures ${rate(st.failRate)}.` : ''].filter(Boolean).join(' ');
  let wx = `${Math.round((t.wr || 0) * 0.6)}% chance of rain during the race.`;
  if (w.weatherMode === 'dry') wx = 'Dry all race.'; else if (w.weatherMode === 'mid') wx = 'Rain is expected during the race.'; else if (w.weatherMode === 'wet') wx = 'A wet start, drying out.';
  else if (st.rainPct !== 'track' && st.rainPct != null) wx = `${st.rainPct}% chance of rain during the race.`;
  return (wx + ' ' + extra).trim();
}

/* ---------------------------------------------------------------- editing */
function stratForm(w, ent) {
  const f = S.ui.form.strat = S.ui.form.strat || {};
  if (!f[ent.id] || f[ent.id].weekendId !== w.id) {
    const doc = f1Plan(w, ent);
    const def = doc ? null : (prevPlanDoc(w, ent) || presetFor('team', w, ent));
    f[ent.id] = { weekendId: w.id, plans: doc ? clone(doc.plans) : def.plans, active: doc ? String(doc.active || 0) : '0', tab: 0,
      triggers: doc ? clone(doc.triggers || []) : def.triggers, approach: doc ? (doc.approach || defaultApproach(ent)) : (def.approach || defaultApproach(ent)), preset: doc ? doc.preset : (def.preset || 'team') };
  }
  return f[ent.id];
}
ACTIONS['strat-tab'] = d => { S.ui.form.strat[d.car].tab = Number(d.i); render(); };
ACTIONS['strat-add'] = d => { const p = S.ui.form.strat[d.car].plans[d.i]; if (p.stops.length >= 3) return;
  const last = p.stops.length ? p.stops[p.stops.length - 1].lap : 0; p.stops.push({ lap: Math.min(raceLaps(S.ui.stratW || F1.live()) - 2, last + 15), compound: 'medium' }); render(); };
ACTIONS['strat-del'] = d => { S.ui.form.strat[d.car].plans[d.i].stops.splice(Number(d.j), 1); render(); };
ACTIONS['strat-suggest'] = d => { const w = S.ui.stratW || F1.live(), ent = weekendEnt(w, d.car); S.ui.form.strat[d.car].plans = suggestPlans(w, ent); toast('Plans filled in from what the team knows about the tyres. Adjust, then save.'); render(); };
ACTIONS['strat-save'] = d => {
  const w = F1.live(), c = currentChar(), ent = w && weekendEnt(w, d.car); if (!w || !c || !ent) return;
  if (!canPlan(w, ent, c.id)) { toast('Only the team principal, this car’s engineer or its driver plan its race.', true); return; }
  if (w.state && w.state.lap > 0) { toast('The race has started: switch plans from the pit wall instead.', true); return; }
  const f = S.ui.form.strat[d.car], N = raceLaps(w);
  run(async () => { await Data.put('f1_plans', `${w.id}-${d.car}-${c.id}`, { userId: asOwner(), charId: c.id, weekendId: w.id, carId: d.car,
    plans: f.plans.map(p => cleanPlan(p, N)), active: Math.max(0, Math.min(2, Number(f.active) || 0)), triggers: (f.triggers || []).slice(0, 6), approach: f.approach || defaultApproach(ent), preset: f.preset || null, at: nowIso() }); },
    `Plans saved. ${PLAN_NAMES[Number(f.active) || 0]} is set for the start.`);
};
ACTIONS['strat-switch'] = d => f1SendCall({ type: 'strategy', carId: d.car, value: Number(d.i) });

/* At the start: every car with a saved plan starts on its tyre and follows it. */
function f1ApplyPlans(w, state) {
  const st = clone(state);
  st.cars.forEach(car => {
    const ent = (w.entrants || []).find(e => e.id === car.id); if (!ent) return;
    /* Saved plans, or for a team with players and nothing saved, the team's own preset and the driver's natural approach. */
    const doc = planDocFor(w, ent); if (!doc) return;
    applyPlanDoc(car, doc, st);
  });
  return st;
}
function f1StrategyCall(w, c) {
  const ent = weekendEnt(w, c.carId), doc = ent && f1Plan(w, ent); if (!doc) return null;
  const i = Number(c.value) || 0, p = cleanPlan(doc.plans[i], w.state.laps);
  return { entry: c.carId, type: 'strategy', plan: i, name: PLAN_NAMES[i], stops: p.stops, wetCall: p.wetCall, dryCall: p.dryCall, useSC: p.useSC };
}

/* ---------------------------------------------------------------- the strategy card */
function stintsHtml(stints) { return stints.map(s => `${f1TyreChip(s.tyre)} <span class="small">${s.from}–${s.to}</span>`).join(' &nbsp;'); }
function planEditorHtml(w, ent, f, i, N, L) {
  const p = f.plans[i], base = `ui/form/strat/${ent.id}/plans/${i}`, sel2 = (id, path, val, opts) => sel(id, path, val, opts);
  const look = planNotes(cleanPlan(p, N), N, L);
  return `<div class="plan">
    <div class="plan-grid"><label class="field">Start on${sel2(`sp-${ent.id}-${i}-start`, base + '/start', p.start, DRY_TYRES)}</label>
      <label class="field">If it rains, go onto wet tyres${sel2(`sp-${ent.id}-${i}-wet`, base + '/wetCall', p.wetCall, WET_CALLS)}</label>
      <label class="field">As it dries, back onto slicks${sel2(`sp-${ent.id}-${i}-dry`, base + '/dryCall', p.dryCall, DRY_CALLS)}</label></div>
    <table class="data compact stops"><thead><tr><th>Stop</th><th>Lap</th><th>New tyres</th><th></th></tr></thead><tbody>
      ${p.stops.map((s, j) => `<tr><td>${j + 1}</td><td><label class="sr-only" for="sp-${ent.id}-${i}-${j}-lap">Lap for stop ${j + 1}</label><input id="sp-${ent.id}-${i}-${j}-lap" type="number" min="2" max="${N - 1}" value="${esc(s.lap)}" data-bind="${base}/stops/${j}/lap" data-type="number" style="max-width:90px"></td>
        <td><label class="sr-only" for="sp-${ent.id}-${i}-${j}-c">Tyre for stop ${j + 1}</label>${sel2(`sp-${ent.id}-${i}-${j}-c`, `${base}/stops/${j}/compound`, s.compound, DRY_TYRES)}</td>
        <td><button class="btn small" data-act="strat-del" data-car="${esc(ent.id)}" data-i="${i}" data-j="${j}">Remove</button></td></tr>`).join('') || '<tr><td colspan="4" class="muted">No stops: start to finish on one set (risky, and against the rules in a dry race).</td></tr>'}</tbody></table>
    <div class="btn-row">${p.stops.length < 3 ? `<button class="btn small" data-act="strat-add" data-car="${esc(ent.id)}" data-i="${i}">Add a stop</button>` : ''}
      <label class="small"><input type="checkbox" data-bind="${base}/useSC" ${p.useSC !== false ? 'checked' : ''}> Take a stop under a safety car if one is due within 10 laps</label></div>
    <p class="plan-look">${stintsHtml(look.stints)}</p>${look.notes.map(n => `<p class="small warn-note">${esc(n)}</p>`).join('')}</div>`;
}
function f1StrategyCardHtml(w) {
  if (!w || w.status === 'finished') return '';
  const c = currentChar(); if (!c) return '';
  const cars = (w.entrants || f1Entrants()).filter(e => canPlan(w, e, c.id) && (!S.ui.wkCarNow || e.id === S.ui.wkCarNow)); if (!cars.length) return '';
  S.ui.stratW = w;
  const N = raceLaps(w), started = !!(w.state && w.state.lap > 0), locked = raceLocked(w);
  const body = cars.map(ent => {
    const t = F1.team(ent.teamId), doc = f1Plan(w, ent), by = doc ? get('characters', doc.charId) : null;
    if (started) {
      const car = w.state.cars.find(x => x.id === ent.id); if (!car || car.status !== 'running') return '';
      const pend = f1Calls(w).find(x => x.type === 'strategy' && x.carId === ent.id), plans = doc ? doc.plans : [];
      const next = (car.plan || [])[0];
      if (locked) return `<div class="f1-car" style="--team:${esc(t.color)}"><h3>${esc(ent.name)}</h3>${lockedStatusHtml(w, ent, car)}</div>`;
      return `<div class="f1-car" style="--team:${esc(t.color)}"><h3>${esc(ent.name)}</h3>
        <p>${car.planned ? `On <b>${esc(car.planName || 'the team’s plan')}</b>. ${next ? `Next stop: lap ${next.lap}, ${esc(RaceEngine.COMPOUNDS[next.compound].label.toLowerCase())}s.` : 'No more stops planned.'}` : 'No plan saved: the AI strategist is running this car.'}</p>
        ${plans.length ? `<div class="btn-row">${plans.map((p, i) => `<button class="btn small" data-act="strat-switch" data-car="${esc(ent.id)}" data-i="${i}" aria-pressed="${!!(pend && Number(pend.value) === i)}" ${car.planName === PLAN_NAMES[i] && !pend ? 'disabled' : ''}>Switch to ${PLAN_NAMES[i]}</button>`).join('')}</div>
          <p class="muted small">Switching keeps the stops still ahead in that plan, and its weather calls.</p>` : ''}</div>`;
    }
    const f = stratForm(w, ent), L = tyreKnowledge(w, ent), tab = f.tab || 0;
    return `<div class="f1-car" style="--team:${esc(t.color)}"><h3>${esc(ent.name)}</h3>
      <p class="muted small">Tyre life here: ${['soft', 'medium', 'hard'].map(k => `${f1TyreChip(k)} about ${L[k].laps} laps${L[k].measured ? '' : ' (rough guide)'}`).join(' &nbsp; ')}. ${Object.values(L).some(x => !x.measured) ? 'Long runs in practice measure them properly.' : 'Measured in practice.'}</p>
      ${doc ? `<p class="small">Saved by ${esc(by ? by.name : 'the team')} ${esc(fmtWhen(doc.at))}. ${esc(PLAN_NAMES[doc.active || 0])} is set for the start.</p>` : `<p class="small">${esc(planSourceText(w, ent))} Shown below; change anything and save.</p>`}
      <div class="tabs" role="tablist">${PLAN_NAMES.map((n, i) => `<button role="tab" class="tab" data-act="strat-tab" data-car="${esc(ent.id)}" data-i="${i}" aria-selected="${tab === i}">${n}</button>`).join('')}</div>
      ${presetBarHtml(ent, f)}
      ${planEditorHtml(w, ent, f, tab, N, L)}
      ${approachHtml(ent, f)}
      ${triggersEditorHtml(ent, f, N)}
      <div class="btn-row"><label class="field" style="margin:0">Start the race on${sel(`sp-${ent.id}-active`, `ui/form/strat/${ent.id}/active`, f.active, PLAN_NAMES.map((n, i) => [String(i), n]))}</label>
        <button class="btn primary" data-act="strat-save" data-car="${esc(ent.id)}">Save all three plans</button>
        <button class="btn" data-act="strat-suggest" data-car="${esc(ent.id)}">Suggest plans</button></div></div>`;
  }).join('');
  if (!body.trim()) return '';
  return `<section class="card strategy"><h2>Race strategy <span class="sub">${esc(raceLaps(w))} laps. ${esc(forecastText(w))}</span></h2>
    ${!started ? `<p class="muted small">The team principal, the car’s engineer and its driver can all plan; the last plans saved are the ones the car uses. ${raceSettings(w).lock !== false ? 'This is an official race: once it starts, nothing can be changed. The plans, triggers and race approach run the car.' : 'Plans can be switched from here during the race.'}</p>` : ''}${body}</section>`;
}

/* =====================================================================
   F1 SIM — driver moments.
   When a player's driver is right behind someone, has someone right
   behind them, or is lining up a safety-car restart, the race offers them
   a choice for the next lap. The odds shown come from the race engine and
   are the odds used. In a live race Race Control's run waits up to 45
   seconds for the answer; otherwise the driver's instinct decides.
   ===================================================================== */
'use strict';

const MOMENT_WAIT = 45000;
const MOMENT_GAP = 0.9;          // seconds: close enough for a moment
const MOMENT_COOLDOWN = 5;       // laps between moments for one car
const MOMENT_CHOICES = {
  attack: [['outside', 'Around the outside', 'The bold move: the best chance, and the most risk of contact.'], ['inside', 'Down the inside', 'Late on the brakes: a decent chance, less risk.'],
    ['boost', 'Use the boost', 'Spend battery for a clean run past. Needs 35% battery.'], ['wait', 'Bide your time', 'No attempt: save tyres and battery for later.']],
  defend: [['cover', 'Cover the inside', 'Defend hard: the best chance to hold on, costs a little time.'], ['hold', 'Hold your line', 'Race them fairly.'],
    ['concede', 'Let them by', 'Save your tyres for the fight that matters.']],
  restart: [['jump', 'Go for the jump', 'Gain time at the restart, or get it wrong.'], ['safe', 'Play it safe', 'Clean restart, no risk.']]
};
const MOMENT_TITLE = { attack: o => `You’re right behind ${o}`, defend: o => `${o} is all over the back of you`, restart: () => 'The safety car is coming in' };

const pendingMoments = w => (w && w.moments || []).filter(m => !m.resolved && w.state && m.lap === w.state.lap + 1);
const momentCall = (w, m) => f1Calls(w).filter(c => c.type === 'moment' && c.momentId === m.id && f1CallAllowed(c, w)).pop() || null;
/* The driver's instinct, when nobody answers. */
function defaultChoice(m, car) {
  const ap = car && car.approach;
  if (ap === 'attacker') return { attack: 'outside', defend: 'cover', restart: 'jump' }[m.kind];
  if (ap === 'defender') return { attack: 'inside', defend: 'cover', restart: 'safe' }[m.kind];
  if (ap === 'tyres') return { attack: 'wait', defend: 'concede', restart: 'safe' }[m.kind];
  const ag = (car && car.driver && car.driver.aggression) || 50;
  if (m.kind === 'attack') return ag >= 65 ? 'outside' : ag >= 50 ? 'inside' : 'wait';
  if (m.kind === 'defend') return ag >= 60 ? 'cover' : 'hold';
  return ag >= 60 ? 'jump' : 'safe';
}
/* After a lap: new moments for players' drivers. */
function f1NewMoments(w, st, log) {
  if (st.finished || st.sc.type && !log.some(l => (l.kind === 'sc' || l.kind === 'vsc') && /ends/.test(l.text))) return [];
  const restart = log.some(l => l.kind === 'sc' && /ends/.test(l.text)), order = f1Order(st).filter(c => c.status === 'running'), out = [];
  const recent = id => (w.moments || []).some(m => m.carId === id && m.lap > st.lap - MOMENT_COOLDOWN);
  (w.entrants || []).filter(e => e.charId).forEach(e => {
    const car = order.find(c => c.id === e.id); if (!car || recent(e.id)) return;
    const i = order.indexOf(car), ahead = order[i - 1], behind = order[i + 1];
    let kind = null, opp = null;
    if (restart) kind = 'restart';
    else if (ahead && car.cum - ahead.cum < MOMENT_GAP) { kind = 'attack'; opp = ahead.id; }
    else if (behind && behind.cum - car.cum < MOMENT_GAP) { kind = 'defend'; opp = behind.id; }
    if (kind) out.push({ id: newId('mom'), carId: e.id, kind, opponent: opp, lap: st.lap + 1, createdAt: nowIso() });
  });
  return out;
}
/* Before a lap: settle the pending moments into engine calls. */
function f1MomentCalls(w) {
  const calls = [], resolved = [];
  pendingMoments(w).forEach(m => {
    const call = momentCall(w, m), car = w.state.cars.find(c => c.id === m.carId);
    const choice = call && MOMENT_CHOICES[m.kind].some(x => x[0] === call.value) ? call.value : defaultChoice(m, car);
    calls.push({ entry: m.carId, type: 'moment', kind: m.kind, choice });
    resolved.push(Object.assign({}, m, { resolved: true, choice, auto: !call }));
  });
  return { calls, resolved };
}
function momentsAnswered(w) { return pendingMoments(w).every(m => !!momentCall(w, m)); }
function momentWaitLeft(w) {
  const p = pendingMoments(w); if (!p.length) return 0;
  return Math.max(0, MOMENT_WAIT - (Date.now() - Math.min(...p.map(m => Date.parse(m.createdAt)))));
}
ACTIONS['moment-choose'] = d => {
  const w = F1.live(); if (!w) return;
  const m = (w.moments || []).find(x => x.id === d.id); if (!m || m.resolved) { toast('That moment has passed.', true); return; }
  f1SendCall({ type: 'moment', carId: m.carId, value: d.choice, momentId: m.id });
};

/* The choice card on the driver's pit wall. */
function f1MomentCardHtml(w) {
  if (!w || w.status !== 'running' || !S.charId || raceLocked(w)) return '';
  const mine = pendingMoments(w).filter(m => f1CallAllowed({ type: 'moment', carId: m.carId, charId: S.charId }, w)); if (!mine.length) return '';
  return mine.map(m => {
    const st = w.state, car = st.cars.find(c => c.id === m.carId), opp = m.opponent ? st.cars.find(c => c.id === m.opponent) : null;
    const call = momentCall(w, m), left = Math.ceil(momentWaitLeft(w) / 1000);
    const odds = ch => RaceEngine.momentOdds(m.kind, ch, car, opp, st.circuit);
    const oppName = opp ? f1Ent(w, opp.id).name : '';
    return `<section class="card moment" aria-live="assertive"><p class="eyebrow">Driver moment, lap ${m.lap}</p><h2>${esc(MOMENT_TITLE[m.kind](oppName))}</h2>
      <p class="muted">${w.live ? `The race waits ${left > 0 ? `${left} more seconds` : 'a moment longer'} for your call; after that your instinct decides.` : 'Choose before Race Control runs the next lap; otherwise your instinct decides.'}</p>
      <div class="choices">${MOMENT_CHOICES[m.kind].filter(c => c[0] !== 'boost' || !st.rules.noHybrid).map(([k, l, d]) => { const o = odds(k), pct = Math.round(o.success * 100);
        return `<button class="choice" data-act="moment-choose" data-id="${esc(m.id)}" data-choice="${k}" aria-pressed="${!!(call && call.value === k)}"><b>${esc(l)}</b><span>${esc(d)}</span>
          <span class="odds">${['wait', 'concede', 'safe'].indexOf(k) !== -1 ? 'No risk' : `${pct}% ${m.kind === 'defend' ? 'to hold on' : m.kind === 'restart' ? 'to gain time' : 'to make it stick'}${o.contact ? `, ${Math.round(o.contact * 100)}% contact risk` : ''}`}</span></button>`; }).join('')}</div>
      ${call ? `<p class="small">Your call: <b>${esc(MOMENT_CHOICES[m.kind].find(x => x[0] === call.value)[1])}</b>. You can change it until the lap runs.</p>` : ''}</section>`;
  }).join('');
}

/* =====================================================================
   F1 SIM — notifications and announcements.
   Each person's feed is worked out from the league's records: decisions
   on their applications, seats, race weekends, contract offers, a team-
   mate changing their plans, awards, driver moments, and announcements
   from Race Control. What's been read is remembered on this device.
   ===================================================================== */
'use strict';

const seenKey = () => 'f1sim.seen.' + (S.uid || 'anon');
const lastSeen = () => lsGet(seenKey()) || '1970';
function f1Feed() {
  const items = [], mine = S.isGm ? list('characters').filter(c => c.userId === S.uid) : myChars(), mineIds = new Set(mine.map(c => c.id));
  const add = (at, text, route, opts) => { if (at) items.push(Object.assign({ at, text, route }, opts || {})); };
  list('f1_notices').forEach(n => add(n.at, `${n.title}`, 'notices', { kind: 'notice', body: n.body }));
  mine.forEach(c => {
    if (c.decidedAt && (c.status === 'approved' || c.status === 'returned')) add(c.decidedAt, c.status === 'approved' ? `${c.name}’s application was approved.` : `${c.name}’s application came back with a note from Race Control.`, 'character', { charId: c.id });
  });
  list('f1_applications').filter(a => mineIds.has(a.charId) && a.decidedAt).forEach(a => add(a.decidedAt, `${a.charName}’s application to ${F1.team(a.teamId).name}: ${a.status === 'approved' ? 'you have the seat' : 'declined'}.`, 'grid'));
  F1.seats().filter(s => mineIds.has(s.holderCharId) && s.holderSince).forEach(s => add(s.holderSince, `${s.holderName} is now ${seatTitle(s).toLowerCase()} at ${F1.team(s.teamId).name}.`, 'team'));
  F1.weekends().forEach(w => { const t = F1.track(w.trackId) || {}, nm = `${t.name || ''}${w.session === 'sprint' ? ' sprint' : ''}`;
    add(w.createdAt, `${nm} weekend is open: practice has started.`, 'weekend');
    if (w.status === 'finished') { const win = (w.results || [])[0]; add(w.finishedAt, `${nm}: ${win ? win.name + ' wins' : 'race finished'}.`, 'weekend'); }
    if (S.charId && w.status !== 'finished') {
      (w.entrants || f1Entrants()).filter(e => canPlan(w, e, S.charId)).forEach(e => { const p = f1Plan(w, e);
        if (p && p.charId !== S.charId) add(p.at, `${(get('characters', p.charId) || {}).name || 'A team-mate'} saved the race plans for ${e.name}.`, 'weekend'); });
    }
    (w.moments || []).filter(m => !m.resolved).forEach(m => { const e = (w.entrants || []).find(x => x.id === m.carId); if (e && mineIds.has(e.charId)) items.push({ at: nowIso(), text: `Driver moment for ${e.name}: make your call now.`, route: 'weekend', urgent: true }); });
  });
  if (typeof f1ContractOffersFor === 'function') mine.forEach(c => f1ContractOffersFor(c.id).forEach(o => add(o.at, `${F1.team(o.teamId).name} has offered ${c.name} a contract.`, 'character', { charId: c.id })));
  if (typeof f1AwardsFor === 'function') mine.forEach(c => f1AwardsFor(f1PcId(c.id)).forEach(a => add(a.at, `${c.name}: ${a.label}, ${a.where}.`, 'career', { personId: f1PcId(c.id) })));
  return items.sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 80);
}
const unreadCount = () => { const seen = lastSeen(); return f1Feed().filter(i => i.urgent || String(i.at) > seen).length; };
ACTIONS['feed-open'] = d => {
  const i = f1Feed()[Number(d.i)]; if (!i) return;
  if (i.charId) S.ui.charEdit = i.charId; if (i.personId) S.ui.career = i.personId;
  go(i.route || 'home');
};
route('notices', 'Notifications', function () {
  const seen = lastSeen(), feed = f1Feed(), notices = list('f1_notices').sort((a, b) => String(b.at).localeCompare(String(a.at)));
  setTimeout(() => { lsSet(seenKey(), nowIso()); }, 0);
  return `<div class="page-head"><div><h1>Notifications</h1><p>What’s happened for you and your characters, newest first.</p></div></div>
    ${notices.length ? `<section class="card"><h2>From Race Control</h2>${notices.slice(0, 5).map(n => `<article class="notice-item"><p class="muted small">${esc(fmtWhen(n.at))}</p><h3>${esc(n.title)}</h3>${paras(n.body)}</article>`).join('')}</section>` : ''}
    <section class="card"><ul class="feed-list">${feed.length ? feed.map((i, n) => `<li class="${i.urgent ? 'urgent' : String(i.at) > seen ? 'new' : ''}"><button class="linkish" data-act="feed-open" data-i="${n}">${esc(i.text)}</button><span class="muted small">${i.urgent ? 'Now' : esc(fmtWhen(i.at))}</span></li>`).join('') : '<li class="muted">Nothing yet.</li>'}</ul></section>`;
});

/* ---------------------------------------------------------------- announcements (Race Control) */
ACTIONS['notice-post'] = () => {
  const f = S.ui.form.notice || {}, title = String(f.title || '').trim(), body = String(f.body || '').trim();
  if (!title || !body) { toast('Give the announcement a title and some words.', true); return; }
  run(async () => {
    await Data.put('f1_notices', newId('note'), { title, body, at: nowIso(), by: actorLabel() });
    if (f.discord) await discordSend('announcements', { embeds: [{ title, description: body.slice(0, 3900), color: 0xE10600, footer: { text: 'F1 SIM, Race Control' } }] });
    await Data.audit('notice.post', `Announcement: ${title}`);
    S.ui.form.notice = {};
  }, f.discord ? 'Announcement posted, here and on Discord.' : 'Announcement posted.');
};
ACTIONS['notice-delete'] = d => askConfirm('Delete this announcement?', 'Delete', () => run(async () => { await Data.remove('f1_notices', d.id); }, 'Announcement deleted.'), true);
function noticeComposerHtml() {
  const f = S.ui.form.notice = S.ui.form.notice || {}, all = list('f1_notices').sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return `<section class="card"><h2>Announcements</h2><p class="muted small">Briefings, rule changes, race-night times. Everyone sees them in Notifications.</p>
    <label class="field">Title<input id="nt-title" type="text" data-bind="ui/form/notice/title" value="${esc(f.title || '')}" placeholder="e.g. Silverstone weekend: practice opens Friday at 8pm"></label>
    <label class="field">Announcement<textarea id="nt-body" rows="4" data-bind="ui/form/notice/body">${esc(f.body || '')}</textarea></label>
    <div class="btn-row"><button class="btn primary" data-act="notice-post">Post the announcement</button><label class="small"><input type="checkbox" data-bind="ui/form/notice/discord" ${f.discord ? 'checked' : ''}> Also post it to Discord</label></div>
    ${all.length ? `<details style="margin-top:12px"><summary>Earlier announcements</summary><table class="data compact"><tbody>${all.map(n => `<tr><td class="nowrap">${esc(fmtDate(n.at))}</td><td>${esc(n.title)}</td><td class="num"><button class="btn small" data-act="notice-delete" data-id="${esc(n.id)}">Delete</button></td></tr>`).join('')}</tbody></table></details>` : ''}</section>`;
}

/* =====================================================================
   F1 SIM — driver profiles, awards and driver cards.
   A profile for every driver: portrait, particulars, diary, the
   relationships players declare, track rivals worked out from the race
   logs, a career timeline, the trophy cabinet and the race-by-race
   record. Awards come from the results (pole, win, fastest lap, biggest
   climber, set-up of the weekend) plus Driver of the Day, voted by
   everyone after each race. Driver cards are drawn in the browser as
   images to download or, for Race Control, post to Discord.
   ===================================================================== */
'use strict';

/* ---------------------------------------------------------------- portraits */
async function shrinkImage(file, max) {
  const url = URL.createObjectURL(file), img = new Image();
  await new Promise((ok, bad) => { img.onload = ok; img.onerror = bad; img.src = url; });
  const k = Math.min(1, max / Math.max(img.width, img.height)), c = document.createElement('canvas');
  c.width = Math.round(img.width * k); c.height = Math.round(img.height * k); c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  URL.revokeObjectURL(url);
  return new Promise(ok => c.toBlob(ok, 'image/jpeg', 0.86));
}
CHANGES['portrait'] = (v, d, el) => {
  const file = el.files && el.files[0], c = get('characters', d.id); if (!file || !c) return;
  if (!/^image\//.test(file.type)) { toast('Choose a picture: a JPEG, PNG or WebP.', true); return; }
  run(async () => {
    const blob = await shrinkImage(file, 900), assets = await window.claude.use('assets');
    const up = await assets.upload(blob, { type: 'image/jpeg' });
    await Data.put('characters', c.id, Object.assign(clone(S.store.characters[c.id]), { portraitUrl: up.url, updatedAt: nowIso() }));
  }, 'Portrait saved.');
  el.value = '';
};
const portraitHtml = (c, size) => c && c.portraitUrl ? `<img class="portrait" src="${esc(c.portraitUrl)}" alt="${esc(c.name)}" width="${size}" height="${size}" loading="lazy">`
  : `<span class="portrait none" style="width:${size}px;height:${size}px" aria-hidden="true">${esc((c && (c.code || f1Code(c.name))) || '')}</span>`;

/* ---------------------------------------------------------------- awards and Driver of the Day */
const votesFor = w => list('f1_votes').filter(v => v.weekendId === w.id);
const votingOpen = w => w.status === 'finished' && !F1.weekends().some(x => x.id !== w.id && String(x.createdAt) > String(w.finishedAt));
function dotdWinner(w) {
  const tally = new Map(); votesFor(w).forEach(v => tally.set(v.personId, (tally.get(v.personId) || 0) + 1));
  if (!tally.size) return null;
  const pos = id => ((w.results || []).find(r => r.personId === id) || {}).position || 99;
  const [personId, votes] = [...tally.entries()].sort((a, b) => b[1] - a[1] || pos(a[0]) - pos(b[0]))[0];
  return { personId, votes, total: votesFor(w).length };
}
function weekendAwards(w) {
  if (w.status !== 'finished') return [];
  const t = F1.track(w.trackId) || {}, where = `${t.name || ''}${w.session === 'sprint' ? ' sprint' : ''}`, at = w.finishedAt, rs = w.results || [], out = [];
  const byCode = code => (w.entrants || []).find(e => e.id === code) || {};
  const pole = w.quali && w.quali.grid ? byCode(w.quali.grid[0]) : null;
  if (pole && pole.personId && w.session === 'gp') out.push({ key: 'pole', label: 'Pole position', personId: pole.personId, where, at });
  if (rs[0]) out.push({ key: 'win', label: w.session === 'sprint' ? 'Sprint win' : 'Race win', personId: rs[0].personId, where, at });
  if (w.state && w.state.fastest) { const f = byCode(w.state.fastest.id); if (f.personId) out.push({ key: 'fastest', label: 'Fastest lap', personId: f.personId, where, at }); }
  const climb = rs.filter(r => r.position).map(r => ({ r, g: r.grid - r.position })).sort((a, b) => b.g - a.g)[0];
  if (climb && climb.g >= 3) out.push({ key: 'climber', label: `Biggest climber (${climb.g} places)`, personId: climb.r.personId, where, at });
  const d = dotdWinner(w); if (d && !votingOpen(w)) out.push({ key: 'dotd', label: 'Driver of the Day', personId: d.personId, where, at });
  if (w.setupBy && w.setup) { const best = Object.keys(w.setupBy).sort((a, b) => w.setup[b] - w.setup[a])[0]; if (best) out.push({ key: 'setup', label: 'Set-up of the weekend', personId: f1PcId(w.setupBy[best]), where, at }); }
  return out;
}
const f1AwardsFor = personId => F1.allWeekends().flatMap(weekendAwards).filter(a => a.personId === personId);
ACTIONS['dotd-vote'] = d => {
  const w = get('f1_weekends', d.w); if (!w || !votingOpen(w)) { toast('Voting for this race has closed.', true); return; }
  run(async () => { await Data.put('f1_votes', `${w.id}-${S.uid}`, { userId: S.uid, weekendId: w.id, personId: d.id, at: nowIso() }); }, 'Vote counted. You can change it until the next weekend opens.');
};
function dotdHtml(w) {
  if (w.status !== 'finished') return '';
  const open = votingOpen(w), mine = votesFor(w).find(v => v.userId === S.uid), win = dotdWinner(w), rs = (w.results || []).filter(r => r.position);
  const tally = new Map(); votesFor(w).forEach(v => tally.set(v.personId, (tally.get(v.personId) || 0) + 1));
  const cands = rs.slice(0, 10).concat(rs.filter(r => r.charId && r.position > 10)).concat(rs.filter(r => r.grid - r.position >= 5 && r.position > 10));
  const uniq = [...new Map(cands.map(r => [r.personId, r])).values()];
  return `<section class="card dotd"><h2>Driver of the Day</h2>
    ${open ? `<p class="muted small">Everyone gets one vote. ${mine ? 'You can change yours until the next weekend opens.' : 'Voting closes when the next weekend opens.'}</p>
      <div class="vote-grid">${uniq.map(r => `<button class="vote ${mine && mine.personId === r.personId ? 'on' : ''}" data-act="dotd-vote" data-w="${esc(w.id)}" data-id="${esc(r.personId)}" aria-pressed="${!!(mine && mine.personId === r.personId)}" style="--team:${esc(f1Colour(r.teamId))}">
        <b>${esc(r.name)}</b><span>P${r.position} from P${r.grid}</span>${mine ? `<span class="votes">${tally.get(r.personId) || 0}</span>` : ''}</button>`).join('')}</div>`
      : win ? `<p><b>${careerLink(win.personId, (F1.person(win.personId) || {}).name || '')}</b>, with ${plural(win.votes, 'vote')} of ${win.total}.</p>` : '<p class="muted">Nobody voted.</p>'}</section>`;
}

/* ---------------------------------------------------------------- diary and relationships */
const REL_KINDS = [['rival', 'Rival'], ['friend', 'Friend'], ['mentor', 'Mentor'], ['history', 'Unfinished business']];
ACTIONS['diary-new'] = () => { S.ui.form.diary = { title: '', body: '' }; openDrawer('diary'); };
DRAWERS.diary = function () {
  const f = S.ui.form.diary || {}, c = currentChar();
  return `<header><div><h2>Diary</h2><p>Written as ${esc(c ? c.name : '')}. Diary entries appear on the profile for everyone to read.</p></div><button class="btn ghost" data-act="close-drawer">Close</button></header>
    <div class="body"><label class="field">Title<input id="di-title" type="text" data-bind="ui/form/diary/title" value="${esc(f.title || '')}" placeholder="e.g. Monza, Thursday night"></label>
    <label class="field">Entry<textarea id="di-body" rows="12" data-bind="ui/form/diary/body">${esc(f.body || '')}</textarea></label>
    <div class="btn-row"><button class="btn primary" data-act="diary-save">Save the entry</button></div></div>`;
};
ACTIONS['diary-save'] = () => { const f = S.ui.form.diary || {}, c = currentChar(); if (!c) return;
  if (!String(f.title || '').trim() || !String(f.body || '').trim()) { toast('Give the entry a title and some words.', true); return; }
  run(async () => { await Data.put('f1_diary', newId('di'), { userId: asOwner(), charId: c.id, title: f.title.trim(), body: f.body.trim(), at: nowIso() }); closeDrawer(); }, 'Diary entry saved.'); };
ACTIONS['diary-delete'] = d => askConfirm('Delete this diary entry?', 'Delete', () => run(async () => { await Data.remove('f1_diary', d.id); }, 'Entry deleted.'), true);
ACTIONS['rel-new'] = () => { S.ui.form.rel = { otherId: '', kind: 'rival', note: '' }; openDrawer('rel'); };
DRAWERS.rel = function () {
  const f = S.ui.form.rel || {}, c = currentChar(), people = list('f1_people').filter(p => p.id !== f1PcId(c && c.id)).sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return `<header><div><h2>A relationship</h2><p>Who matters to ${esc(c ? c.name : '')}, and how. It shows on both profiles.</p></div><button class="btn ghost" data-act="close-drawer">Close</button></header>
    <div class="body"><label class="field">Who${sel('rel-other', 'ui/form/rel/otherId', f.otherId, people.map(p => [p.id, p.name + (p.charId ? ' (player)' : '')]), 'Choose someone')}</label>
    <label class="field">What they are${sel('rel-kind', 'ui/form/rel/kind', f.kind, REL_KINDS)}</label>
    <label class="field">The story (optional)<textarea id="rel-note" rows="4" data-bind="ui/form/rel/note" placeholder="e.g. Karting rivals since they were nine. Neither has forgiven Macau.">${esc(f.note || '')}</textarea></label>
    <div class="btn-row"><button class="btn primary" data-act="rel-save">Save</button></div></div>`;
};
ACTIONS['rel-save'] = () => { const f = S.ui.form.rel || {}, c = currentChar(); if (!c || !f.otherId) { toast('Choose someone.', true); return; }
  run(async () => { await Data.put('f1_relations', newId('rel'), { userId: asOwner(), charId: c.id, personId: f1PcId(c.id), otherId: f.otherId, kind: f.kind || 'rival', note: String(f.note || '').trim(), at: nowIso() }); closeDrawer(); }, 'Saved to the profile.'); };
ACTIONS['rel-delete'] = d => run(async () => { await Data.remove('f1_relations', d.id); }, 'Removed.');

/* Track rivals: who they've swapped places with most, from every race log. */
function trackRivals(personId) {
  const m = new Map();
  F1.allWeekends().filter(w => w.status === 'finished').forEach(w => {
    const me = (w.entrants || []).find(e => e.personId === personId); if (!me) return;
    ((w.state && w.state.events) || []).filter(e => (e.kind === 'overtake' || e.kind === 'moment') && (e.ids || []).length === 2 && e.ids.indexOf(me.id) !== -1).forEach(e => {
      const otherCode = e.ids[0] === me.id ? e.ids[1] : e.ids[0], other = (w.entrants || []).find(x => x.id === otherCode); if (!other) return;
      const r = m.get(other.personId) || { personId: other.personId, name: other.name, teamId: other.teamId, won: 0, lost: 0 };
      if (e.kind === 'overtake') { if (e.ids[0] === me.id) r.won++; else r.lost++; } else if (/stick|holds off/.test(e.text)) r.won += e.ids[0] === me.id ? 1 : 0;
      m.set(other.personId, r);
    });
  });
  return [...m.values()].sort((a, b) => (b.won + b.lost) - (a.won + a.lost)).slice(0, 4);
}
/* The career timeline, from the records. */
function timeline(p) {
  const out = [], c = p.charId ? get('characters', p.charId) : null;
  if (c && c.decidedAt && c.status === 'approved') out.push({ at: c.decidedAt, text: 'Approved by Race Control' });
  const seat = p.charId ? F1.seats().find(s => s.holderCharId === p.charId) : null;
  if (seat && seat.holderSince) out.push({ at: seat.holderSince, text: `${seatTitle(seat)} at ${F1.team(seat.teamId).name}` });
  if (typeof f1ContractsFor === 'function' && p.charId) f1ContractsFor(p.charId).forEach(k => out.push({ at: k.signedAt, text: `Signed with ${F1.team(k.teamId).name}${k.salary ? `, £${k.salary}m a season` : ''}` }));
  const rec = f1Record(p.id), firsts = {};
  rec.forEach(x => { const t = F1.track(x.w.trackId) || {}, where = t.name + (x.w.session === 'sprint' ? ' sprint' : ''), pos = x.r.position;
    if (!firsts.start) { firsts.start = 1; out.push({ at: x.w.finishedAt, text: `First race: ${where}, ${pos ? 'P' + pos : 'retired'}` }); }
    if (pos && x.r.points && !firsts.points) { firsts.points = 1; out.push({ at: x.w.finishedAt, text: `First points: P${pos} at ${where}` }); }
    if (pos && pos <= 3 && !firsts.podium && x.w.session === 'gp') { firsts.podium = 1; out.push({ at: x.w.finishedAt, text: `First podium: P${pos} at ${where}` }); }
    if (pos === 1 && x.w.session === 'gp') out.push({ at: x.w.finishedAt, text: `Won the ${where}` });
  });
  f1AwardsFor(p.id).filter(a => a.key === 'dotd' || a.key === 'pole').forEach(a => out.push({ at: a.at, text: `${a.label}, ${a.where}` }));
  return out.sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

/* ---------------------------------------------------------------- driver cards */
const CARD_KINDS = [['card', 'Driver card'], ['signing', 'New signing'], ['pole', 'Pole position'], ['win', 'Race winner'], ['dotd', 'Driver of the Day']];
async function drawCard(personId, kind, where) {
  const p = F1.person(personId); if (!p) return null;
  const c = p.charId ? get('characters', p.charId) : null, seat = c ? F1.seats().find(s => s.holderCharId === c.id) : F1.seats().find(s => s.defaultPersonId === p.id);
  const team = F1.team(seat ? seat.teamId : p.teamId), col = team.color || '#E10600', rec = f1Record(p.id);
  const W = 1080, H = 1350, cv = document.createElement('canvas'); cv.width = W; cv.height = H; const g = cv.getContext('2d');
  try { await Promise.all(['700 200px "Titillium Web"', '600 40px "Titillium Web"'].map(f => document.fonts.load(f))); } catch (e) { /* fall back */ }
  const cond = (wt, px) => `${wt} ${px}px "Titillium Web", "Arial Narrow", sans-serif`, body = (wt, px) => `${wt} ${px}px "Titillium Web", system-ui, sans-serif`;
  g.fillStyle = '#14181C'; g.fillRect(0, 0, W, H);
  const grad = g.createLinearGradient(0, 0, W, H); grad.addColorStop(0, col); grad.addColorStop(0.62, '#14181C'); g.globalAlpha = 0.9; g.fillStyle = grad; g.fillRect(0, 0, W, H); g.globalAlpha = 1;
  g.font = cond(700, 760); g.fillStyle = 'rgba(255,255,255,0.07)'; g.textAlign = 'right'; g.fillText(String(p.num || p.abbr || ''), W - 20, 820);
  if (c && c.portraitUrl) { try { const img = new Image(); img.crossOrigin = 'anonymous'; await new Promise((ok, bad) => { img.onload = ok; img.onerror = bad; img.src = c.portraitUrl; });
    const s = Math.max(760 / img.width, 860 / img.height), w = img.width * s, h = img.height * s; g.save(); g.beginPath(); g.rect(160, 120, 760, 860); g.clip(); g.drawImage(img, 160 + (760 - w) / 2, 120 + (860 - h) / 2, w, h); g.restore();
    const fade = g.createLinearGradient(0, 700, 0, 990); fade.addColorStop(0, 'rgba(20,24,28,0)'); fade.addColorStop(1, 'rgba(20,24,28,1)'); g.fillStyle = fade; g.fillRect(160, 700, 760, 290); } catch (e) { /* no portrait */ } }
  g.textAlign = 'left'; g.fillStyle = '#fff';
  const lg = typeof leagueLogo === 'function' ? await loadImg(leagueLogo()) : null;
  if (lg) { const h = 48, lw = Math.min(220, lg.width / lg.height * h); g.drawImage(lg, 64, 62, lw, h); g.fillStyle = '#fff'; g.font = cond(700, 44); g.fillText('F1 SIM', 64 + lw + 16, 100); }
  else { for (let r = 0; r < 2; r++) for (let q = 0; q < 2; q++) { g.fillStyle = (r + q) % 2 ? 'rgba(255,255,255,0.15)' : '#fff'; g.fillRect(64 + q * 18, 64 + r * 18, 18, 18); }
    g.fillStyle = '#fff'; g.font = cond(700, 44); g.fillText('F1 SIM', 120, 98); }
  const label = (CARD_KINDS.find(k => k[0] === kind) || CARD_KINDS[0])[1];
  g.font = cond(700, 56); g.fillStyle = col; g.fillRect(64, 150, g.measureText(label).width + 40, 76); g.fillStyle = '#fff'; g.fillText(label, 84, 208);
  const parts = String(p.name).split(' '), last = parts.pop(), first = parts.join(' ');
  g.font = body(500, 56); g.fillText(first, 64, 1060);
  let size = 190; g.font = cond(700, size); while (g.measureText(last.toUpperCase()).width > W - 128 && size > 90) { size -= 8; g.font = cond(700, size); }
  g.fillText(last.toUpperCase(), 60, 1060 + size * 0.86);
  g.font = body(600, 40); g.fillStyle = 'rgba(255,255,255,0.86)';
  const line2 = [team.name, p.num ? '#' + p.num : '', c && c.nationality ? c.nationality : ''].filter(Boolean).join('   ');
  g.fillText(line2, 64, H - 70);
  if (where) { g.textAlign = 'right'; g.fillText(where, W - 64, H - 70); g.textAlign = 'left'; }
  g.fillStyle = col; g.fillRect(0, H - 22, W, 22);
  if (kind === 'card' || kind === 'signing') {
    const stats = rec.length ? [['Races', rec.filter(x => x.w.session === 'gp').length], ['Wins', rec.filter(x => x.w.session === 'gp' && x.r.position === 1).length], ['Points', rec.reduce((a, x) => a + (x.r.points || 0), 0)]]
      : [['Pace', p.pace], ['Racecraft', Math.round(((p.overtaking || 0) + (p.defense || 0)) / 2)], ['Wet', p.wet]];
    stats.forEach(([k, v], i) => { const x = 64 + i * 200; g.fillStyle = '#fff'; g.font = cond(700, 88); g.fillText(String(v), x, 330); g.font = body(500, 32); g.fillStyle = 'rgba(255,255,255,0.75)'; g.fillText(k, x, 372); });
  }
  return new Promise(ok => cv.toBlob(ok, 'image/png'));
}
ACTIONS['card-open'] = d => { S.ui.card = { personId: d.id, kind: d.kind || 'card', where: d.where || '', url: null }; openDrawer('card'); refreshCard(); };
async function refreshCard() {
  const c = S.ui.card; if (!c) return;
  const blob = await drawCard(c.personId, c.kind, c.where); if (!blob || S.ui.card !== c) return;
  if (c.url) URL.revokeObjectURL(c.url); c.blob = blob; c.url = URL.createObjectURL(blob); renderOverlay();
}
CHANGES['card-kind'] = v => { S.ui.card.kind = v; refreshCard(); renderOverlay(); };
DRAWERS.card = function () {
  const c = S.ui.card || {}, p = F1.person(c.personId);
  return `<header><div><h2>Driver card</h2><p>${esc(p ? p.name : '')}. Download it, or post it to Discord.</p></div><button class="btn ghost" data-act="close-drawer">Close</button></header>
    <div class="body"><label class="field">Kind of card<select id="card-kind" data-change="card-kind">${CARD_KINDS.map(([k, l]) => `<option value="${k}" ${c.kind === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    ${c.url ? `<img class="card-preview" src="${c.url}" alt="The driver card">` : '<p class="muted">Drawing the card…</p>'}
    <div class="btn-row"><button class="btn primary" data-act="card-download" ${c.url ? '' : 'disabled'}>Download</button>${S.isGm ? `<button class="btn" data-act="card-discord" ${c.url ? '' : 'disabled'}>Post to Discord</button>` : ''}</div></div>`;
};
ACTIONS['card-download'] = () => { const c = S.ui.card; if (!c || !c.url) return; const a = document.createElement('a'); a.href = c.url; a.download = `${(F1.person(c.personId) || {}).abbr || 'driver'}-${c.kind}.png`; document.body.appendChild(a); a.click(); a.remove(); };
ACTIONS['card-discord'] = () => { const c = S.ui.card; if (!c || !c.blob) return; const p = F1.person(c.personId), label = (CARD_KINDS.find(k => k[0] === c.kind) || CARD_KINDS[0])[1];
  run(async () => { await discordSend('cards', { content: `**${label}:** ${p.name}${c.where ? `, ${c.where}` : ''}` }, { blob: c.blob, name: `${p.abbr || 'driver'}-${c.kind}.png` }); await Data.audit('discord.card', `${label} card for ${p.name} posted to Discord`); }, 'Posted to Discord.'); };

/* ---------------------------------------------------------------- the profile page */
route('career', 'Driver profile', function () {
  const p = F1.person(S.ui.career); if (!p) return `<div class="empty">Choose a driver from The Grid or the Championship.</div>`;
  const c = p.charId ? get('characters', p.charId) : null, mine = !!(c && (c.userId === S.uid || S.isGm) && S.charId === c.id);
  const rec = f1Record(p.id), gps = rec.filter(x => x.w.session === 'gp'), seat = c ? F1.seats().find(s => s.holderCharId === c.id) : F1.seats().find(s => s.defaultPersonId === p.id && !s.holderCharId);
  const team = seat ? F1.team(seat.teamId) : F1.team(p.teamId), pts = rec.reduce((a, x) => a + (x.r.points || 0), 0);
  const wins = gps.filter(x => x.r.position === 1).length, pods = gps.filter(x => x.r.position && x.r.position <= 3).length, poles = gps.filter(x => x.pole).length;
  const best = Math.min(...gps.map(x => x.r.position || 99)), vs = gps.filter(x => x.mate), mates = [...new Set(vs.map(x => x.mate.name))];
  const awards = f1AwardsFor(p.id), counts = {}; awards.forEach(a => { counts[a.label.replace(/ \(.*\)$/, '')] = (counts[a.label.replace(/ \(.*\)$/, '')] || 0) + 1; });
  const diary = c ? list('f1_diary').filter(x => x.charId === c.id).sort((a, b) => String(b.at).localeCompare(String(a.at))) : [];
  const rels = list('f1_relations').filter(r => r.personId === p.id || r.otherId === p.id);
  const relName = id => (F1.person(id) || {}).name || 'someone', relKind = k => (REL_KINDS.find(x => x[0] === k) || [k, k])[1];
  const rivals = trackRivals(p.id), tl = timeline(p);
  const ratings = c ? f1DevApply(Object.assign({}, F1_ROOKIE, p), c.id) : p;
  const isDriver = !p.kind || p.kind === 'driver';
  return `<div class="profile-head" style="--team:${esc(team.color || '#888')}">${portraitHtml(c || { name: p.name, code: p.abbr }, 132)}
      <div><p class="eyebrow">${team && teamBrand(team.id).logo ? `<img class="team-logo tiny" src="${esc(teamBrand(team.id).logo)}" alt="">` : ''}${esc(F1_ROLE[p.kind] || 'Driver')}${team ? ', ' + esc(team.name) : ''}${c ? '' : ', real'}</p><h1>${p.flag ? esc(p.flag) + ' ' : ''}${esc(p.name)}</h1>
        <p class="muted">${[c && c.nickname ? `“${c.nickname}”` : '', yearsNow(p) ? plural(yearsNow(p), 'year') + ' of experience' : '', p.num ? '#' + p.num : '', c && c.nationality, c && c.birthplace ? 'from ' + c.birthplace : ''].filter(Boolean).map(esc).join(', ')}</p>
        <div class="btn-row">${mine ? `<label class="btn small file-btn">Change portrait<input type="file" accept="image/*" data-change="portrait" data-id="${esc(c.id)}" class="sr-only"></label>
          <button class="btn small" data-act="diary-new">Write in the diary</button><button class="btn small" data-act="rel-new">Add a relationship</button>` : ''}
          ${isDriver ? `<button class="btn small" data-act="card-open" data-id="${esc(p.id)}" data-kind="card">Driver card</button>` : ''}</div></div></div>
    ${c && (c.bio || c.junior || c.helmet) ? `<section class="card">${c.bio ? paras(c.bio) : ''}${c.junior ? `<h4>Before Formula 1</h4>${paras(c.junior)}` : ''}${c.helmet ? `<p class="muted small">Helmet: ${esc(c.helmet)}</p>` : ''}</section>` : ''}
    ${isDriver ? `<div class="metrics"><div class="metric"><b>${gps.length}</b><span>Grands Prix</span></div><div class="metric"><b>${wins}</b><span>Wins</span></div><div class="metric"><b>${pods}</b><span>Podiums</span></div><div class="metric"><b>${pts}</b><span>Points</span></div></div>` : ''}
    <div class="cols2">
      ${isDriver ? `<section class="card"><h2>Record</h2><table class="data compact"><tbody><tr><td>Pole positions</td><td class="num">${poles}</td></tr><tr><td>Best finish</td><td class="num">${best < 99 ? 'P' + best : '–'}</td></tr>
        <tr><td>Retirements</td><td class="num">${gps.filter(x => !x.r.position).length}</td></tr>
        ${mates.length ? `<tr><td>Against ${esc(mates.join(' and '))}, races</td><td class="num">${vs.filter(x => x.beat).length} to ${vs.filter(x => !x.beat).length}</td></tr><tr><td>Against ${esc(mates.join(' and '))}, qualifying</td><td class="num">${vs.filter(x => x.qbeat).length} to ${vs.filter(x => !x.qbeat).length}</td></tr>` : ''}</tbody></table>
        <h4>Trophy cabinet</h4>${awards.length ? `<p>${Object.keys(counts).map(k => `<span class="tag trophy">${esc(k)}${counts[k] > 1 ? ' ×' + counts[k] : ''}</span>`).join(' ')}</p>` : '<p class="muted small">Empty, for now.</p>'}</section>
      <section class="card"><h2>Ratings</h2>${c ? devPanelHtml(c.id) : `<table class="data compact"><tbody>${F1_RATINGS.map(([k, l]) => `<tr><td>${esc(l)}</td><td class="num"><b>${esc(ratings[k])}</b></td></tr>`).join('')}</tbody></table>`}</section>` : ''}
      <section class="card"><h2>Relationships</h2>${rels.length ? `<ul class="rels">${rels.map(r => { const mineRel = r.personId === p.id;
          return `<li><span class="tag ${r.kind}">${esc(relKind(r.kind))}</span> ${mineRel ? careerLink(r.otherId, relName(r.otherId)) : `${careerLink(r.personId, relName(r.personId))} counts them as a ${esc(relKind(r.kind).toLowerCase())}`}${r.note ? `<p class="muted small">${esc(r.note)}</p>` : ''}${mineRel && mine ? ` <button class="btn small ghost" data-act="rel-delete" data-id="${esc(r.id)}">Remove</button>` : ''}</li>`; }).join('')}</ul>` : '<p class="muted small">None declared.</p>'}
        ${rivals.length ? `<h4>On track</h4><table class="data compact"><tbody>${rivals.map(r => `<tr><td><span class="f1-bar" style="background:${esc(f1Colour(r.teamId))}"></span>${careerLink(r.personId, r.name)}</td><td class="num">${r.won} passes for, ${r.lost} against</td></tr>`).join('')}</tbody></table>` : ''}</section>
      <section class="card"><h2>Timeline</h2>${tl.length ? `<ol class="timeline">${tl.map(x => `<li><span class="muted small">${esc(fmtDate(x.at))}</span> ${esc(x.text)}</li>`).join('')}</ol>` : '<p class="muted small">The story starts at the first race.</p>'}</section></div>
    ${diary.length ? `<section class="card"><h2>Diary</h2>${diary.slice(0, 10).map(d => `<article class="diary"><p class="muted small">${esc(fmtWhen(d.at))}</p><h3>${esc(d.title)}</h3>${paras(d.body)}${mine ? `<button class="btn small ghost" data-act="diary-delete" data-id="${esc(d.id)}">Delete</button>` : ''}</article>`).join('')}</section>` : ''}
    ${rec.length ? `<section class="card"><h2>Race by race</h2><div class="scroll-x"><table class="data"><thead><tr><th>Race</th><th>Team</th><th class="num">Grid</th><th class="num">Finish</th><th class="num">Points</th></tr></thead><tbody>${rec.slice().reverse().map(x => { const t = F1.track(x.w.trackId) || {};
      return `<tr><td>${esc(t.name || '')}${x.w.session === 'sprint' ? ' sprint' : ''}</td><td><span class="f1-bar" style="background:${esc(f1Colour(x.r.teamId))}"></span>${esc(F1.team(x.r.teamId).name)}</td><td class="num">${x.r.grid}</td><td class="num">${x.r.position ? 'P' + x.r.position : 'Out'}</td><td class="num">${x.r.points || ''}</td></tr>`; }).join('')}</tbody></table></div></section>` : ''}`;
});

/* Years of experience: what was rolled, plus one for every catalogued season they've raced in since. */
function yearsNow(p) {
  if (!p) return 0;
  const base = p.years != null ? p.years : (p.fictional ? Math.max(1, Math.round(((p.experience || 40) - 15) / 7)) : 0); if (!base) return 0;
  const seasons = list('f1_seasons').filter(s => s.status === 'archived' && (!p.approvedAt || String(s.endedAt) > String(p.approvedAt)) && ((s.archive || {}).drivers || []).some(d => d.personId === p.id)).length;
  return base + seasons;
}

/* =====================================================================
   F1 SIM — team depth: power units, contracts, sponsors and rapport.
   Power units belong to the car (not the driver). Each car has an
   allowance for the season; a fresh unit beyond it means a grid penalty.
   Older units fail more often and lose a little power. A power unit
   failure means a new one at the next weekend. Crashes cost money to
   repair. Team principals offer contracts (paid from the budget) and
   choose one sponsor deal for the season. Race engineers who work with
   the same driver weekend after weekend build rapport: clearer feedback
   and a better set-up.
   ===================================================================== */
'use strict';

const PU_ALLOWANCE_DEFAULT = 4;
const puAllow = () => curSeries().development ? engineFormula().pu : null;
const PU_EXTRA_COST = 1;      // £m for each unit beyond the allowance
const REPAIR_COST = 0.8;      // £m after an accident
const carKey = (teamId, car) => `${teamId}-${car}`;
const seasonWeekends = () => F1.weekends().filter(w => w.session !== 'test' && (w.status !== 'practice' || w.state)).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));

/* ---------------------------------------------------------------- power units */
/* Fits ordered for a car at a weekend: by the team principal or that car's engineer. */
function puOrdered(w, key) {
  const [teamId, car] = [key.slice(0, key.lastIndexOf('-')), Number(key.slice(key.lastIndexOf('-') + 1))];
  return list('f1_parts').some(p => p.weekendId === w.id && p.carKey === key && F1.seats(teamId).some(s => s.holderCharId === p.charId && (s.role === 'principal' || (s.role === 'engineer' && s.car === car))));
}
/* The car's power unit story up to (and including) weekend w: how many it has used, how old the current one is, and whether one was fitted there. */
function puState(key, w) {
  const weeks = seasonWeekends(), upto = w ? weeks.filter(x => x.id !== w.id && String(x.createdAt) < String(w.createdAt)).concat([w]) : weeks;
  const teamId = key.slice(0, key.lastIndexOf('-')), car = Number(key.slice(key.lastIndexOf('-') + 1));
  const ai = !(F1.seats(teamId).some(s => s.holderCharId && (s.role === 'principal' || (s.role === 'engineer' && s.car === car))));
  let count = 1, age = 0, broke = false, fits = [];
  upto.forEach((x, i) => {
    let fit = broke || puOrdered(x, key) || (ai && age >= 6 && count < puAllow());
    if (fit && i > 0) { count += 1; age = 0; fits.push({ w: x, forced: broke, n: count }); } else if (i > 0) age += 1;
    const ent = (x.entrants || []).find(e => e.teamId === teamId && e.car === car), res = ent && (x.results || []).find(r => r.id === ent.id);
    broke = !!(res && /power unit|energy store/.test(res.gap || ''));
  });
  const last = fits[fits.length - 1], here = !!(last && w && last.w.id === w.id);
  return { count, age, fitted: here, forced: here && last.forced, over: Math.max(0, count - puAllow()), brokeLast: broke, ai };
}
/* Grid penalty for this weekend: 10 places for the first unit over the allowance, 5 for each one after. */
function puPenalty(st) { return st.fitted && st.count > puAllow() ? (st.count === puAllow() + 1 ? 10 : 5) : 0; }
/* Applied at qualifying: older units are slower and less reliable; penalties move cars back on the grid. */
function f1PuEffects(w, entrants, entries) {
  const penalties = {}; if (!puAllow()) return penalties;
  entrants.forEach(e => {
    const st = puState(carKey(e.teamId, e.car), w), en = entries.find(x => x.id === e.id); if (!en) return;
    en.car = Object.assign({}, en.car, { wear: Math.min(150, st.age * 14), power: (en.car.power || 85) - Math.max(0, st.age - 3) * 0.4 });
    const pen = puPenalty(st); if (pen) penalties[e.id] = { places: pen, reason: `power unit ${st.count} of ${puAllow()}` };
  });
  return penalties;
}
function f1PuGrid(grid, penalties, log) {
  const g = grid.slice();
  Object.keys(penalties).sort((a, b) => g.indexOf(a) - g.indexOf(b)).forEach(id => { const i = g.indexOf(id); g.splice(i, 1); g.splice(Math.min(g.length, i + penalties[id].places), 0, id);
    log.push({ kind: 'penalty', ids: [id], text: `${id} takes a ${penalties[id].places}-place grid penalty for a new ${penalties[id].reason.replace(/^power unit (\d+)/, 'power unit, number $1')}` }); });
  return g;
}
ACTIONS['pu-fit'] = d => {
  const w = F1.live(), c = currentChar(); if (!w || !c) { toast('Fit a power unit while a weekend is open, before qualifying.', true); return; }
  if (w.status !== 'practice') { toast('Power units are fitted before qualifying.', true); return; }
  if (!seasonWeekends().some(x => x.id !== w.id)) { toast('Every car starts the season on a fresh unit.', true); return; }
  const st = puState(d.key, w);
  const go2 = () => run(async () => { await Data.put('f1_parts', `${w.id}-${d.key}`, { userId: asOwner(), charId: c.id, weekendId: w.id, carKey: d.key, part: 'pu', at: nowIso() }); }, 'New power unit ordered for this weekend.');
  if (st.count + 1 > puAllow()) askConfirm(`That would be power unit ${st.count + 1} of ${puAllow()}: a ${st.count + 1 === puAllow() + 1 ? 10 : 5}-place grid penalty and £${PU_EXTRA_COST}m. Fit it anyway?`, 'Fit it and take the penalty', go2, true);
  else go2();
};
ACTIONS['pu-cancel'] = d => run(async () => { await Data.remove('f1_parts', d.id); }, 'Power unit order cancelled.');

/* ---------------------------------------------------------------- sponsors */
const SPONSORS = {
  title: { label: 'Title partner', upfront: 6, blurb: '£6m now, then £0.3m for every car that scores points.', per: (rs) => rs.filter(r => r.points).length * 0.3 },
  podium: { label: 'Performance partner', upfront: 2, blurb: '£2m now, then £1.2m for every podium.', per: (rs, w) => w.session === 'gp' ? rs.filter(r => r.position && r.position <= 3).length * 1.2 : 0 },
  steady: { label: 'Reliability backer', upfront: 3, blurb: '£3m now, then £0.6m every Grand Prix both cars finish.', per: (rs, w) => w.session === 'gp' && rs.length >= 2 && rs.every(r => r.position) ? 0.6 : 0 },
  youth: { label: 'Young talent fund', upfront: 2, blurb: '£2m now, then £0.8m whenever a player’s driver scores points.', per: rs => rs.some(r => r.charId && r.points) ? 0.8 : 0 }
};
/* The team's sponsor: the first deal signed by whoever was team principal. It can't be changed mid-season. */
function f1Sponsor(teamId) {
  const tp = F1.seats(teamId).find(s => s.role === 'principal');
  return list('f1_contracts').filter(k => k.kind === 'sponsor' && k.teamId === teamId && recSeason(k) === curSeasonId() && SPONSORS[k.deal] && (k.locked || (tp && tp.holderCharId === k.charId)))
    .sort((a, b) => String(a.at).localeCompare(String(b.at)))[0] || null;
}
ACTIONS['sponsor-sign'] = d => {
  const c = currentChar(), tp = F1.seats(d.team).find(s => s.role === 'principal'); if (!c || !tp || tp.holderCharId !== c.id) { toast('Only the team principal signs sponsors.', true); return; }
  if (f1Sponsor(d.team)) { toast('A sponsor is already signed for this season.', true); return; }
  askConfirm(`Sign with the ${SPONSORS[d.deal].label.toLowerCase()} for the season? It can’t be changed afterwards.`, 'Sign the deal', () => run(async () => {
    await Data.put('f1_contracts', newId('spon'), { kind: 'sponsor', userId: asOwner(), charId: c.id, teamId: d.team, deal: d.deal, seasonId: curSeasonId(), at: nowIso() });
    await Data.audit('sponsor.sign', `${F1.team(d.team).name} signs a ${SPONSORS[d.deal].label.toLowerCase()}`); }, 'Sponsor signed.'));
};

/* ---------------------------------------------------------------- contracts */
const offersOf = teamId => list('f1_contracts').filter(k => k.kind === 'offer' && k.teamId === teamId && recSeason(k) === curSeasonId());
const replyTo = id => list('f1_contracts').filter(k => (k.kind === 'accept' || k.kind === 'decline') && k.offerId === id).sort((a, b) => String(a.at).localeCompare(String(b.at)))[0] || null;
/* A contract stands when the team principal offered it and the character's own player accepted. */
function f1ContractsFor(charId) {
  return list('f1_contracts').filter(k => k.kind === 'offer' && k.toCharId === charId).map(o => ({ o, r: replyTo(o.id) }))
    .filter(x => x.r && x.r.kind === 'accept' && x.r.charId === charId).map(x => Object.assign({}, x.o, { signedAt: x.r.at }));
}
const f1ContractOffersFor = charId => list('f1_contracts').filter(k => k.kind === 'offer' && k.toCharId === charId && !replyTo(k.id));
function activeContract(charId, teamId) {
  return f1ContractsFor(charId).filter(k => k.teamId === teamId && recSeason(k) === curSeasonId()).sort((a, b) => String(b.signedAt).localeCompare(String(a.signedAt)))[0] || null;
}
function contractLeft(k) { if (!k.races) return 'the end of the season'; const done = finishedAll().filter(w => String(w.finishedAt) > String(k.signedAt) && w.session === 'gp').length; return k.races - done > 0 ? plural(k.races - done, 'more Grand Prix', 'more Grands Prix') : 'its end'; }
ACTIONS['offer-new'] = d => { S.ui.form.offer = { teamId: d.team, toCharId: d.char, salary: 2, races: 0, terms: '' }; openDrawer('offer'); };
DRAWERS.offer = function () {
  const f = S.ui.form.offer || {}, who = get('characters', f.toCharId), t = F1.team(f.teamId);
  return `<header><div><h2>Offer ${esc(who ? who.name : '')} a contract</h2><p>${esc(t.name)}. The salary comes out of the team’s budget, a share at each Grand Prix.</p></div><button class="btn ghost" data-act="close-drawer">Close</button></header>
    <div class="body"><div class="form-grid"><label class="field">Salary (£m a season)<input id="of-sal" type="number" min="0" max="20" step="0.5" data-bind="ui/form/offer/salary" data-type="number" value="${esc(f.salary)}"></label>
      <label class="field">Length${sel('of-len', 'ui/form/offer/races', String(f.races || 0), [['0', 'To the end of the season'], ['5', 'Five Grands Prix'], ['10', 'Ten Grands Prix']])}</label></div>
    <label class="field">Terms (optional)<textarea id="of-terms" rows="4" data-bind="ui/form/offer/terms" placeholder="e.g. Number one status for the first five races. Release clause if not in the top 10.">${esc(f.terms || '')}</textarea></label>
    <div class="btn-row"><button class="btn primary" data-act="offer-send">Send the offer</button></div></div>`;
};
ACTIONS['offer-send'] = () => {
  const f = S.ui.form.offer || {}, c = currentChar(), tp = F1.seats(f.teamId).find(s => s.role === 'principal');
  if (!c || !tp || tp.holderCharId !== c.id) { toast('Only the team principal makes offers.', true); return; }
  run(async () => { await Data.put('f1_contracts', newId('off'), { kind: 'offer', userId: asOwner(), charId: c.id, teamId: f.teamId, seasonId: curSeasonId(), toCharId: f.toCharId, salary: Math.max(0, Number(f.salary) || 0), races: Number(f.races) || 0, terms: String(f.terms || '').trim(), at: nowIso() }); closeDrawer(); }, 'Offer sent.');
};
ACTIONS['offer-reply'] = d => {
  const o = get('f1_contracts', d.id), c = get('characters', o && o.toCharId); if (!o || !c || (c.userId !== S.uid && !S.isGm)) return;
  run(async () => { await Data.put('f1_contracts', newId('rep'), { kind: d.yes === '1' ? 'accept' : 'decline', offerId: o.id, userId: c.userId, charId: c.id, at: nowIso() });
    if (d.yes === '1') await Data.audit('contract.sign', `${c.name} signs with ${F1.team(o.teamId).name}`); }, d.yes === '1' ? 'Contract signed.' : 'Offer declined.');
};
function offersHtml(charId) {
  const offers = f1ContractOffersFor(charId); if (!offers.length) return '';
  return `<section class="card"><h2>Contract offers</h2>${offers.map(o => `<article class="offer" style="--team:${esc(F1.team(o.teamId).color)}"><h3>${esc(F1.team(o.teamId).name)}</h3>
    <p>£${o.salary}m a season, ${o.races ? `for ${o.races} Grands Prix` : 'to the end of the season'}.</p>${o.terms ? paras(o.terms) : ''}
    <div class="btn-row"><button class="btn primary" data-act="offer-reply" data-id="${esc(o.id)}" data-yes="1">Sign it</button><button class="btn" data-act="offer-reply" data-id="${esc(o.id)}" data-yes="0">Turn it down</button></div></article>`).join('')}</section>`;
}


/* ---------------------------------------------------------------- rapport */
/* Weekends the car's engineer and driver (both players) have locked a set-up in together. */
function f1Rapport(teamId, car) {
  const eng = F1.seats(teamId).find(s => s.role === 'engineer' && s.car === car), drv = F1.seats(teamId).find(s => s.role === 'driver' && s.car === car);
  if (!eng || !drv || !eng.holderCharId || !drv.holderCharId) return 0;
  return F1.weekends().filter(w => w.setupBy && (w.entrants || []).some(e => e.teamId === teamId && e.car === car && e.charId === drv.holderCharId && w.setupBy[e.id] === eng.holderCharId)).length;
}
const rapportNoise = n => 1 - Math.min(0.5, n * 0.1);
const rapportSetup = n => Math.min(4, n);

/* ---------------------------------------------------------------- Team HQ sections */
function teamDepthHtml(tid) {
  const team = F1.team(tid), c = currentChar(), tp = F1.seats(tid).find(s => s.role === 'principal'), isTp = !!(c && tp && tp.holderCharId === c.id);
  const inTeam = S.isGm || F1.seats(tid).some(s => c && s.holderCharId === c.id); if (!inTeam) return '';
  const w = F1.live(), sp = f1Sponsor(tid);
  const cars = F1.seats(tid).filter(x => x.role === 'driver').map(x => x.car);
  const pu = cars.map(car => { const key = carKey(tid, car), st = puState(key, w && w.status === 'practice' ? w : null), drv = F1.seats(tid).find(s => s.role === 'driver' && s.car === car);
    const ordered = w && list('f1_parts').find(p => p.weekendId === w.id && p.carKey === key);
    const canFit = c && w && w.status === 'practice' && seasonWeekends().some(x => x.id !== w.id) && F1.seats(tid).some(s => s.holderCharId === c.id && (s.role === 'principal' || (s.role === 'engineer' && s.car === car)));
    const n = f1Rapport(tid, car);
    return `<tr><td><b>Car ${car}</b><br><span class="muted small">${esc(drv ? f1Occupant(drv).name : '')}</span></td>
      ${puAllow() ? `      <td>Unit ${st.count} of ${puAllow()}${st.over ? ` <span class="tag flag">${st.over} over</span>` : ''}<br><span class="muted small">${st.age ? `${plural(st.age, 'weekend')} old${st.age >= 4 ? ': failing more often, a little down on power' : ''}` : 'Fresh'}${st.brokeLast ? '. It failed last time: a new one goes in.' : ''}</span></td>
      <td>${ordered ? `<span class="tag player">New unit this weekend</span> ${canFit ? `<button class="btn small" data-act="pu-cancel" data-id="${esc(ordered.id)}">Cancel</button>` : ''}` : canFit ? `<button class="btn small" data-act="pu-fit" data-key="${esc(key)}">Fit a new power unit</button>` : ''}</td>` : ''}
      <td>${n ? `Rapport: ${plural(n, 'weekend')} together<br><span class="muted small">Feedback ${Math.round((1 - rapportNoise(n)) * 100)}% clearer, +${rapportSetup(n)} set-up</span>` : '<span class="muted small">No rapport yet</span>'}</td></tr>`; }).join('');
  const people = F1.seats(tid).filter(s => s.holderCharId && s.role !== 'principal');
  return `${puAllow() ? '' : '<!--spec-->'}<section class="card"><h2>${puAllow() ? 'Power units and rapport' : 'Rapport'}</h2>${puAllow() ? `<p class="muted small">Each car has ${puAllow()} power units for the season. A new one beyond that costs a grid penalty (10 places, then 5) and £${PU_EXTRA_COST}m. Fit units during practice. Rapport grows each weekend the same engineer and driver lock in a set-up together.</p>` : '<p class="muted small">Identical cars in this series: no power units to manage. Rapport grows each weekend the same engineer and driver lock in a set-up together.</p>'}
      <div class="scroll-x"><table class="data"><tbody>${pu}</tbody></table></div></section>
    <section class="card"><h2>Sponsor</h2>${sp ? `<p><b>${esc(SPONSORS[sp.deal].label)}</b>: ${esc(SPONSORS[sp.deal].blurb)}</p>` : isTp ? `<p>Choose one deal for the season. It can’t be changed afterwards.</p>
      <div class="cards">${Object.keys(SPONSORS).map(k => `<article class="card"><h3>${esc(SPONSORS[k].label)}</h3><p>${esc(SPONSORS[k].blurb)}</p><button class="btn small primary" data-act="sponsor-sign" data-team="${esc(tid)}" data-deal="${k}">Sign this deal</button></article>`).join('')}</div>`
      : '<p class="muted">No sponsor deal signed: the team earns the standard sponsor bonus for meeting its target.</p>'}</section>
    <section class="card"><h2>Contracts</h2>${people.length ? `<table class="data"><tbody>${people.map(s => { const k = activeContract(s.holderCharId, tid), pend = offersOf(tid).find(o => o.toCharId === s.holderCharId && !replyTo(o.id));
      return `<tr><td><b>${esc(s.holderName)}</b><br><span class="muted small">${esc(seatTitle(s))}</span></td><td>${k ? `£${k.salary}m a season, until ${esc(contractLeft(k))}${k.terms ? `<br><span class="muted small">${esc(k.terms)}</span>` : ''}` : pend ? '<span class="tag open">Offer waiting for an answer</span>' : '<span class="muted">No contract</span>'}</td>
        <td>${isTp && !pend ? `<button class="btn small" data-act="offer-new" data-team="${esc(tid)}" data-char="${esc(s.holderCharId)}">${k ? 'Offer a new contract' : 'Offer a contract'}</button>` : ''}</td></tr>`; }).join('')}</tbody></table>` : '<p class="muted">No players in the team’s seats yet.</p>'}
      <p class="muted small">Salaries are paid from the budget, a share at each Grand Prix.</p></section>`;
}

const _teamViewTD = ROUTES.team.view;
ROUTES.team.view = function () {
  const html = _teamViewTD(), teams = F1.teams(); if (!teams.length) return html;
  const my = S.charId ? F1.seats().find(s => s.holderCharId === S.charId) : null, tid = S.ui.teamId || (my && my.teamId) || teams[0].id;
  return html + teamDepthHtml(tid);
};

/* =====================================================================
   F1 SIM — race presets, race approaches, triggers and the official lock.
   Presets fill a car's three plans and its triggers in one go: each
   team's own default (from how that team likes to race), or one of four
   general ones. The race approach drives the car lap by lap. Triggers
   swap plans, change the mode or call a stop when something happens,
   each with a chance of the team acting on it. In an official race,
   nothing can be changed once it starts: the plans, triggers and race
   approach run the car, and driver moments follow the approach.
   ===================================================================== */
'use strict';

const APPROACHES = [['balanced', 'Balanced', 'Races to the plan without fuss.'], ['attacker', 'Attacker', 'Pushes whenever there’s a car to catch, and goes around the outside.'],
  ['defender', 'Defender', 'Pushes when someone’s close behind, and covers the inside.'], ['tyres', 'Tyre saver', 'Manages the tyres in clean air, and picks the battles worth having.']];
const STYLE_APPROACH = { charger: 'attacker', aggressive: 'attacker', defender: 'defender', smooth: 'tyres', strategist: 'tyres', ironman: 'balanced', technical: 'balanced', qualifier: 'balanced' };
const TRIGGER_WHEN = [['sc', 'A safety car comes out'], ['rain', 'It starts to rain'], ['dry', 'The track dries out'], ['lost', 'We’ve lost places from the grid'], ['gained', 'We’ve gained places from the grid'], ['wear', 'Tyre wear reaches']];
const TRIGGER_DO = [['plan0', 'Switch to Plan A'], ['plan1', 'Switch to Plan B'], ['plan2', 'Switch to Plan C'], ['push', 'Push'], ['manage', 'Manage the tyres'], ['box', 'Box this lap']];
const CHANCES = [['100', 'Always'], ['75', '75% of the time'], ['50', 'Half the time'], ['25', 'Now and then (25%)']];
const PRESETS = [['team', 'The team’s own approach'], ['onestop', 'Safe one-stop'], ['twostop', 'Attacking two-stop'], ['wet', 'Wet-weather gamble'], ['sc', 'Safety-car opportunist']];
const ARCH_PRESET = { aggressive_two: 'twostop', undercut_king: 'twostop', one_stop: 'onestop', fuel_save: 'onestop', tyre_banker: 'onestop', overcut: 'onestop', safety_car: 'sc', reactive: 'onestop' };

function defaultApproach(ent) { const v3 = ent.v3 || (f1Entrants().find(x => x.id === ent.id) || {}).v3 || {}; return STYLE_APPROACH[v3.style] || 'balanced'; }
const approachLabel = k => (APPROACHES.find(a => a[0] === k) || APPROACHES[0])[1];
const wetVersion = p => Object.assign({}, clone(p), { wetCall: 'early', dryCall: 'early' });
/* A preset's plans and triggers for this car at this circuit, built on what the team knows about the tyres. */
function presetFor(key, w, ent) {
  const N = raceLaps(w), base = suggestPlans(w, ent), team = F1.team(ent.teamId);
  if (key === 'team') key = ARCH_PRESET[team.strategy] || 'onestop';
  const later = p => Object.assign({}, clone(p), { stops: p.stops.map(s => ({ lap: Math.min(N - 2, s.lap + 6), compound: s.compound })), useSC: true });
  if (key === 'twostop') return { plans: [base[1], base[0], wetVersion(base[1])], triggers: [
    { when: 'sc', from: 8, to: Math.max(9, N - 12), action: 'plan1', chance: '75' }, { when: 'rain', action: 'plan2', chance: '100' }, { when: 'lost', n: 3, action: 'push', chance: '100' }] };
  if (key === 'wet') return { plans: [Object.assign({}, clone(base[0]), { wetCall: 'late', dryCall: 'early' }), wetVersion(base[0]), base[2]], triggers: [
    { when: 'rain', action: 'plan1', chance: '50' }, { when: 'dry', action: 'push', chance: '100' }] };
  if (key === 'sc') return { plans: [later(base[0]), base[1], wetVersion(base[0])], triggers: [
    { when: 'sc', from: 5, to: Math.max(6, N - 8), action: 'plan1', chance: '100' }, { when: 'rain', action: 'plan2', chance: '100' }] };
  return { plans: [base[0], base[1], wetVersion(base[0])], triggers: [{ when: 'rain', action: 'plan2', chance: '100' }, { when: 'wear', n: 100, action: 'box', chance: '100' }] };
}
function cleanTriggers(ts, N) {
  return (ts || []).slice(0, 6).filter(t => TRIGGER_WHEN.some(x => x[0] === t.when) && TRIGGER_DO.some(x => x[0] === t.action)).map(t => {
    const a = t.action, out = { when: t.when, chance: Math.max(0, Math.min(100, Number(t.chance) || 100)) };
    if (t.when === 'lost' || t.when === 'gained') out.n = Math.max(1, Math.min(15, Number(t.n) || 3));
    if (t.when === 'wear') out.n = Math.max(50, Math.min(130, Number(t.n) || 90));
    if (Number(t.from)) out.from = Math.max(1, Math.min(N, Number(t.from))); if (Number(t.to)) out.to = Math.max(1, Math.min(N, Number(t.to)));
    if (/^plan\d$/.test(a)) { out.action = 'plan'; out.plan = Number(a.slice(4)); } else if (a === 'box') out.action = 'box'; else { out.action = 'mode'; out.mode = a; }
    return out;
  });
}
/* Put a team's saved plans (or the defaults) onto a car in the race state. */
function applyPlanDoc(car, doc, st) {
  const i = Number(doc.active) || 0, plans = (doc.plans || []).map((p, k) => Object.assign(cleanPlan(p, st.laps), { name: PLAN_NAMES[k] })), p = plans[i] || plans[0];
  if (!p) return;
  const wet = st.track[0], start = wet === 2 ? 'wet' : wet === 1 ? 'inter' : p.start;
  car.tyre = { compound: start, wear: 0, age: 0 }; car.stints = [{ compound: start, from: 1, to: null }]; car.used = [start];
  car.plan = p.stops.map(s => ({ lap: s.lap, compound: s.compound })); car.planned = true; car.planName = PLAN_NAMES[i];
  car.plans = plans; car.triggers = cleanTriggers(doc.triggers, st.laps).map(t => Object.assign(t, { fired: false })); car.approach = doc.approach || 'balanced'; car.modeHold = 0;
  car.ai = Object.assign({}, car.ai, { wetCall: p.wetCall, dryCall: p.dryCall, useSC: p.useSC });
}
/* Cars in a team with players but no saved plans start on the team's own preset and the driver's natural approach. */
function defaultPlanDoc(w, ent) { const pr = presetFor('team', w, ent); return { plans: pr.plans, active: 0, triggers: pr.triggers, approach: defaultApproach(ent), isDefault: true }; }
const teamHasPlayers = teamId => F1.seats(teamId).some(s => s.holderCharId);

/* ---------------------------------------------------------------- official races */
const raceSettings = w => Object.assign({ lock: true, scRate: 1, failRate: 1, extRate: 1, rainPct: 'track' }, (w && w.settings) || {});
const rateNum = v => v == null || v === '' || isNaN(Number(v)) ? 1 : Number(v);
const raceLocked = w => !!(w && w.state && w.state.lap > 0 && !w.state.finished && !w.test && raceSettings(w).lock !== false);
const RACE_CALLS = ['box', 'mode', 'order', 'refuseOrder', 'strategy', 'moment'];

/* ---------------------------------------------------------------- the editor pieces */
ACTIONS['strat-preset'] = d => {
  const w = S.ui.stratW || F1.live(), ent = weekendEnt(w, d.car), key = ((S.ui.form.presetPick || {})[d.car]) || 'team'; if (!ent) return;
  const pr = presetFor(key, w, ent), f = S.ui.form.strat[d.car];
  f.plans = pr.plans; f.triggers = pr.triggers.map(t => Object.assign({}, t, { action: t.action })); f.preset = key; f.tab = 0;
  toast(`${(PRESETS.find(p => p[0] === key) || PRESETS[0])[1]} loaded: three plans and their triggers. Adjust, then save.`); render();
};
ACTIONS['trig-toggle'] = (d, el, ev) => { if (ev) ev.preventDefault(); S.ui.trigOpen = S.ui.trigOpen || {}; S.ui.trigOpen[d.car] = !S.ui.trigOpen[d.car]; render(); };
ACTIONS['trig-add'] = d => { S.ui.trigOpen = S.ui.trigOpen || {}; S.ui.trigOpen[d.car] = true; const f = S.ui.form.strat[d.car]; f.triggers = f.triggers || []; if (f.triggers.length >= 6) return; f.triggers.push({ when: 'sc', action: 'plan1', chance: '100' }); render(); };
ACTIONS['trig-del'] = d => { S.ui.form.strat[d.car].triggers.splice(Number(d.i), 1); render(); };
function triggersEditorHtml(ent, f, N) {
  const base = `ui/form/strat/${ent.id}/triggers`, ts = f.triggers || [];
  const open = !!((S.ui.trigOpen || {})[ent.id]);
  return `<details class="trig-box" ${open ? 'open' : ''}><summary data-act="trig-toggle" data-car="${esc(ent.id)}"><b>Triggers</b> <span class="muted small">${ts.length ? plural(ts.length, 'trigger') + ' set' : 'none set'}: what the team does if something happens</span></summary><p class="muted small">Each trigger fires once, and the team acts on it with the chance you set.</p>
    ${ts.length ? `<div class="triggers">${ts.map((t, i) => `<div class="trigger">
      <label class="field">When${sel(`tg-${ent.id}-${i}-w`, `${base}/${i}/when`, t.when, TRIGGER_WHEN)}</label>
      ${['lost', 'gained', 'wear'].indexOf(t.when) !== -1 ? `<label class="field">${t.when === 'wear' ? 'Wear (%)' : 'Places'}<input id="tg-${ent.id}-${i}-n" type="number" min="1" max="130" value="${esc(t.n || (t.when === 'wear' ? 90 : 3))}" data-bind="${base}/${i}/n" data-type="number"></label>` : ''}
      ${['sc', 'rain', 'dry'].indexOf(t.when) !== -1 ? `<label class="field">From lap<input id="tg-${ent.id}-${i}-f" type="number" min="1" max="${N}" value="${esc(t.from || '')}" placeholder="Any" data-bind="${base}/${i}/from" data-type="number"></label>
        <label class="field">To lap<input id="tg-${ent.id}-${i}-t" type="number" min="1" max="${N}" value="${esc(t.to || '')}" placeholder="Any" data-bind="${base}/${i}/to" data-type="number"></label>` : ''}
      <label class="field">Then${sel(`tg-${ent.id}-${i}-a`, `${base}/${i}/action`, t.action, TRIGGER_DO)}</label>
      <label class="field">Chance${sel(`tg-${ent.id}-${i}-c`, `${base}/${i}/chance`, String(t.chance || '100'), CHANCES)}</label>
      <button class="btn small" data-act="trig-del" data-car="${esc(ent.id)}" data-i="${i}">Remove</button></div>`).join('')}</div>` : '<p class="muted small">No triggers: the car sticks to its starting plan whatever happens.</p>'}
    ${ts.length < 6 ? `<button class="btn small" data-act="trig-add" data-car="${esc(ent.id)}">Add a trigger</button>` : ''}</details>`;
}
function presetBarHtml(ent, f) {
  const pick = (S.ui.form.presetPick = S.ui.form.presetPick || {})[ent.id] || f.preset || 'team', team = F1.team(ent.teamId);
  const arch = FormulaRacingAdapter.ARCHETYPES[team.strategy] || FormulaRacingAdapter.ARCHETYPES.reactive;
  return `<div class="btn-row preset-bar"><label class="field" style="margin:0">Preset${sel(`pp-${ent.id}`, `ui/form/presetPick/${ent.id}`, pick, PRESETS.map(([k, l]) => [k, k === 'team' ? `${team.name}’s own: ${arch.label.toLowerCase()}` : l]))}</label>
    <button class="btn" data-act="strat-preset" data-car="${esc(ent.id)}">Load the preset</button></div>`;
}
function approachHtml(ent, f) {
  return `<label class="field" style="max-width:440px">Race approach${sel(`ap-${ent.id}`, `ui/form/strat/${ent.id}/approach`, f.approach || defaultApproach(ent), APPROACHES.map(([k, l, d]) => [k, `${l}: ${d}`]))}</label>`;
}
/* In a locked race: what the car is doing, and which triggers have fired. */
function lockedStatusHtml(w, ent, car) {
  const fired = w.state.events.filter(e => e.kind === 'trigger' && (e.ids || [])[0] === ent.id);
  return `<p>On <b>${esc(car.planName || 'the AI strategist’s plan')}</b>, ${esc(approachLabel(car.approach).toLowerCase())} approach. ${(car.plan || [])[0] ? `Next stop: lap ${car.plan[0].lap}, ${esc(RaceEngine.COMPOUNDS[car.plan[0].compound].label.toLowerCase())}s.` : 'No more stops planned.'}</p>
    ${(car.triggers || []).length ? `<ul class="trig-status">${car.triggers.map(t => `<li class="${t.fired ? 'fired' : ''}">${esc((TRIGGER_WHEN.find(x => x[0] === t.when) || ['', t.when])[1])}${t.n ? ` (${t.n}${t.when === 'wear' ? '%' : ''})` : ''}: ${t.action === 'plan' ? 'switch to ' + PLAN_NAMES[t.plan] : t.action === 'box' ? 'box' : t.mode} ${t.chance < 100 ? `(${t.chance}%)` : ''}${t.fired ? ' <span class="tag">Fired</span>' : ''}</li>`).join('')}</ul>` : ''}
    ${fired.length ? `<p class="small">${fired.map(e => `Lap ${e.lap}: ${esc(e.text)}`).join('<br>')}</p>` : ''}`;
}

/* ---------------------------------------------------------------- randomness (Race Control, and the Test Track) */
const RATES = [['0', 'None'], ['0.5', 'Fewer than usual'], ['1', 'As usual'], ['2', 'More than usual'], ['3', 'Chaos']];
const RAIN_PCTS = [['track', 'The circuit’s usual'], ['0', 'No chance'], ['20', '20%'], ['40', '40%'], ['60', '60%'], ['90', '90%']];
function randomnessHtml(prefix, f, t) {
  return `<div class="metrics" style="align-items:end">
    <label class="field">Chance of rain (changeable weather)${sel(prefix + '-rain', `ui/form/${prefix}/rainPct`, f.rainPct || 'track', RAIN_PCTS.map(([k, l]) => [k, k === 'track' ? `${l} (${Math.round((t.wr || 0) * 0.6)}%)` : l]))}</label>
    <label class="field">Crashes, contact and driver errors${sel(prefix + '-sc', `ui/form/${prefix}/scRate`, String(f.scRate == null ? '1' : f.scRate), RATES)}</label>
    <label class="field">Mechanical failures and pit problems${sel(prefix + '-fail', `ui/form/${prefix}/failRate`, String(f.failRate == null ? '1' : f.failRate), RATES)}</label>
    <label class="field">Outside events (debris, animals, storms)${sel(prefix + '-ext', `ui/form/${prefix}/extRate`, String(f.extRate == null ? '1' : f.extRate), RATES)}</label>
    <button class="btn small ghost" data-act="inc-open">What can happen?</button></div>`;
}

/* =====================================================================
   F1 SIM — the Test Track.
   The same simulator as the official races, on the league's own grid,
   cars, upgrades and ratings, but run entirely in the browser: nothing
   is saved and nothing counts. Anyone can pick any car, try presets,
   plans, triggers and race approaches, change the chances of rain,
   safety cars and failures, and step in at any moment with the pit
   wall and driver moments.
   ===================================================================== */
'use strict';

S.tt = { cfg: null, w: null, calls: [], choice: {}, timer: null };
function ttCfg() {
  if (!S.tt.cfg) {
    const mine = S.charId ? F1.seats().find(s => s.holderCharId === S.charId && s.role !== 'engineer') : null;
    const ents = F1.teams().length ? f1Entrants() : [], myCar = mine ? (ents.find(e => e.teamId === mine.teamId && (mine.car ? e.car === mine.car : true)) || {}).id : null;
    S.tt.cfg = { trackId: (f1NextTrack() || {}).id, session: 'gp', weatherMode: 'track', rainPct: 'track', scRate: '1', failRate: '1', extRate: '1', seed: '', car: myCar || (ents[0] || {}).id, setup: 75, speed: '1000' };
  }
  return S.ui.form.tt = S.tt.cfg;
}
/* A weekend-shaped object, so the race view, the plan editor and the moments all work as they do in the league. */
function ttW() {
  const f = ttCfg(), w = S.tt.w;
  return w || { id: 'test-' + f.trackId + '-' + f.session, test: true, trackId: f.trackId, session: f.session, seed: Number(f.seed) || 1, weatherMode: f.weatherMode,
    seriesId: curSeriesId(), seasonId: curSeasonId(), settings: { lock: false, scRate: rateNum(f.scRate), failRate: rateNum(f.failRate), extRate: rateNum(f.extRate), rainPct: f.rainPct }, status: 'practice', entrants: null, state: null };
}
function ttStop() { clearTimeout(S.tt.timer); S.tt.timer = null; }
ACTIONS['tt-reset'] = () => { ttStop(); S.tt.w = null; S.tt.calls = []; S.tt.choice = {}; render(); };
ACTIONS['tt-quali'] = () => {
  ttStop();
  const f = ttCfg(), w = ttW(), track = F1.track(f.trackId); if (!track) return;
  const seed = Number(f.seed) || (1 + Math.floor(Math.random() * 999999)); w.seed = seed;
  const entrants = f1Entrants(), mine = entrants.find(e => e.id === f.car) || entrants[0];
  const setup = {}; entrants.forEach(e => { setup[e.id] = e.id === mine.id ? Math.max(20, Math.min(95, Number(f.setup) || 75)) : f1AiSetup(F1.team(e.teamId)); });
  const rs = f1RaceSetup(w, track), weather = f1Weather(w, track), teams = F1.teams().map(t => f1EffectiveTeam(t));
  const entries = FormulaRacingAdapter.toEntries(entrants.map(e => e.v3), teams, track, { setup });
  engineEfficiency(entrants, entries, w);
  const quali = RaceEngine.qualify({ circuit: rs.circuit, entries, weather, seed, rules: rs.rules });
  let state = RaceEngine.createRace({ circuit: rs.circuit, entries, grid: quali.grid, weather, seed, sprint: f.session === 'sprint', rules: rs.rules });
  /* Your car runs your plans; other cars in teams with players run their team defaults. */
  const form = stratForm(w, mine);
  state = clone(state);
  state.cars.forEach(car => { const ent = entrants.find(e => e.id === car.id);
    if (car.id === mine.id) applyPlanDoc(car, { plans: form.plans, active: form.active, triggers: form.triggers, approach: form.approach }, state);
    else if (ent && teamHasPlayers(ent.teamId)) applyPlanDoc(car, defaultPlanDoc(w, ent), state); });
  S.tt.w = Object.assign({}, w, { status: 'grid', seed, weather, quali: { grid: quali.grid, results: quali.results, log: quali.log }, state, moments: [],
    entrants: entrants.map(e => { const o = Object.assign({}, e, { charId: e.id === mine.id ? 'tt-you' : null }); delete o.v3; return o; }) });
  S.tt.calls = []; S.tt.choice = {}; S.ui.f1pick = mine.id; S.ui.f1tab = 'driver';
  render();
};
function ttStep(laps) {
  const w = S.tt.w; if (!w || !w.state || w.state.finished) return null;
  const calls = S.tt.calls.splice(0), resolved = [];
  (w.moments || []).filter(m => !m.resolved && m.lap === w.state.lap + 1).forEach(m => {
    const car = w.state.cars.find(c => c.id === m.carId), choice = S.tt.choice[m.id] || defaultChoice(m, car);
    calls.push({ entry: m.carId, type: 'moment', kind: m.kind, choice }); resolved.push(Object.assign({}, m, { resolved: true, choice, auto: !S.tt.choice[m.id] }));
  });
  let st = w.state, log = [], last = [];
  for (let i = 0; i < laps && !st.finished; i++) {
    const out = RaceEngine.stepLap(st, i === 0 ? calls : []); st = out.state; log = log.concat(out.log); last = out.log;
    if (S.ui.form.ttStopSc !== false && i < laps - 1 && out.log.some(l => (l.kind === 'sc' || l.kind === 'vsc') && /deployed/.test(l.text))) break;
  }
  const done = new Map(resolved.map(m => [m.id, m]));
  w.moments = (w.moments || []).map(m => done.get(m.id) ? Object.assign(done.get(m.id), { outcome: (log.find(l => l.kind === 'moment' && (l.ids || [])[0] === m.carId) || {}).text || 'Nothing came of it.' }) : m);
  w.state = st; w.status = st.finished ? 'finished' : 'running';
  if (laps === 1 && !st.finished) w.moments = w.moments.concat(f1NewMoments(w, st, last));
  if (st.finished) { const byId = new Map(w.entrants.map(e => [e.id, e])); w.results = RaceEngine.classify(st).map(r => Object.assign({}, r, byId.get(r.id) || {})); w.finishedAt = nowIso(); ttStop(); }
  return log;
}
function ttTick() {
  const w = S.tt.w; if (!S.tt.timer || !w || !w.state || w.state.finished) { ttStop(); render(); return; }
  const pend = (w.moments || []).filter(m => !m.resolved && m.lap === w.state.lap + 1 && !S.tt.choice[m.id]);
  if (pend.length && Date.now() - Date.parse(pend[0].createdAt) < MOMENT_WAIT) { S.tt.timer = setTimeout(ttTick, 500); render(); return; }
  const log = ttStep(1);
  if (log && S.ui.form.ttStopSc !== false && log.some(l => (l.kind === 'sc' || l.kind === 'vsc') && /deployed/.test(l.text))) { ttStop(); toast('Safety car: paused. Make your calls, then carry on.'); render(); return; }
  if (S.tt.timer) S.tt.timer = setTimeout(ttTick, Number(ttCfg().speed) || 1000);
  render();
};
ACTIONS['tt-play'] = () => { if (S.tt.timer) { ttStop(); render(); return; } S.tt.timer = setTimeout(ttTick, 50); render(); };
ACTIONS['tt-step'] = d => { ttStop(); ttStep(Number(d.laps) || 1); render(); };
ACTIONS['tt-call'] = d => {
  const w = S.tt.w, car = ttCfg().car; if (!w || !w.state) return;
  S.tt.calls = S.tt.calls.filter(c => c.type !== d.type);
  if (d.type === 'box') S.tt.calls.push({ entry: car, type: 'box', compound: d.value });
  else if (d.type === 'mode') S.tt.calls.push({ entry: car, type: 'mode', value: d.value });
  else if (d.type === 'plan') S.tt.calls.push({ entry: car, type: 'strategy', plan: Number(d.value) });
  toast('Call made: it applies on the next lap.'); render();
};
ACTIONS['tt-moment'] = d => { S.tt.choice[d.id] = d.choice; render(); };
ACTIONS['tt-stopsc'] = (d, el) => { S.ui.form.ttStopSc = !!el.checked; };

function ttMomentHtml(w) {
  const mine = ttCfg().car, m = (w.moments || []).find(x => !x.resolved && x.carId === mine && x.lap === w.state.lap + 1); if (!m) return '';
  const st = w.state, car = st.cars.find(c => c.id === m.carId), opp = m.opponent ? st.cars.find(c => c.id === m.opponent) : null, pick = S.tt.choice[m.id];
  return `<section class="card moment"><p class="eyebrow">Driver moment, lap ${m.lap}</p><h2>${esc(MOMENT_TITLE[m.kind](opp ? f1Ent(w, opp.id).name : ''))}</h2>
    <div class="choices">${MOMENT_CHOICES[m.kind].filter(c => c[0] !== 'boost' || !st.rules.noHybrid).map(([k, l, dsc]) => { const o = RaceEngine.momentOdds(m.kind, k, car, opp, st.circuit);
      return `<button class="choice" data-act="tt-moment" data-id="${esc(m.id)}" data-choice="${k}" aria-pressed="${pick === k}"><b>${esc(l)}</b><span>${esc(dsc)}</span><span class="odds">${['wait', 'concede', 'safe'].indexOf(k) !== -1 ? 'No risk' : `${Math.round(o.success * 100)}%${o.contact ? `, ${Math.round(o.contact * 100)}% contact risk` : ''}`}</span></button>`; }).join('')}</div></section>`;
}
function ttCarHtml(w) {
  const id = ttCfg().car, car = w.state.cars.find(c => c.id === id), e = f1Ent(w, id), t = F1.team(e.teamId); if (!car) return '';
  if (car.status !== 'running') return `<section class="card"><h2>Your car</h2><p>${esc(e.name)} is out: ${esc(car.dnf)}.</p></section>`;
  const life = RaceEngine.tyreLife(car.tyre.compound, car, w.state.circuit), wear = Math.min(100, Math.round(car.tyre.wear / life * 100)), pos = f1Order(w.state).indexOf(car) + 1;
  const pend = type => S.tt.calls.find(c => c.type === type);
  return `<section class="card" style="--team:${esc(t.color)}"><h2>Your car: ${esc(e.name)} <span class="sub">P${pos}, ${esc(car.planName || 'no plan')}, ${esc(approachLabel(car.approach).toLowerCase())}</span></h2>
    <div class="f1-gauges"><div class="f1-gauge">${esc(RaceEngine.COMPOUNDS[car.tyre.compound].label)}s, ${car.tyre.age} laps: wear ${wear}%<div class="track"><div class="fill ${wear >= 90 ? 'hot' : ''}" style="width:${wear}%"></div></div></div>
      <div class="f1-gauge">${w.state.rules.noHybrid ? 'No battery' : `Battery ${Math.round(car.energy)}%`}, ${esc(RaceEngine.MODES[car.mode].label.toLowerCase())}<div class="track"><div class="fill" style="width:${car.energy}%"></div></div></div></div>
    <div class="f1-row"><span class="lbl">Mode</span>${['push', 'standard', 'manage'].map(m => `<button class="btn small" data-act="tt-call" data-type="mode" data-value="${m}" aria-pressed="${(pend('mode') ? pend('mode').value : car.mode) === m}">${RaceEngine.MODES[m].label}</button>`).join('')}</div>
    <div class="f1-row"><span class="lbl">Box</span>${['soft', 'medium', 'hard', 'inter', 'wet'].map(k => `<button class="btn small" data-act="tt-call" data-type="box" data-value="${k}" aria-pressed="${!!(pend('box') && pend('box').compound === k)}">${f1TyreChip(k)} ${k === 'inter' ? 'Inter' : RaceEngine.COMPOUNDS[k].label}</button>`).join('')}</div>
    ${(car.plans || []).length ? `<div class="f1-row"><span class="lbl">Plan</span>${car.plans.map((p, i) => `<button class="btn small" data-act="tt-call" data-type="plan" data-value="${i}" aria-pressed="${!!(pend('strategy') && pend('strategy').plan === i)}" ${car.planName === PLAN_NAMES[i] ? 'disabled' : ''}>Switch to ${PLAN_NAMES[i]}</button>`).join('')}</div>` : ''}
    ${lockedStatusHtml(w, e, car)}</section>`;
}

route('test', 'Test Track', function () {
  if (!F1.teams().length) return '<div class="page-head"><div><h1>Test Track</h1><p>The grid isn’t set up yet.</p></div></div>';
  const f = ttCfg(), w = S.tt.w, tracks = F1.tracks(), t = F1.track(f.trackId) || tracks[0], ents = f1Entrants(), live = !!S.tt.timer;
  let h = `<div class="page-head"><div><h1>Test Track</h1><p>The same simulator as the official races, with the league’s grid, cars and ratings. It runs in your browser: nothing here is saved or counts towards anything, so try whatever you like.</p></div>
    ${w && w.state ? `<div class="f1-lap ${live ? 'live' : ''}"><small>${w.state.finished ? 'Chequered flag' : w.state.lap ? 'Test, lap' : 'Grid set'}</small>${w.state.lap}<span class="of">/${w.state.laps}</span></div>` : ''}</div>`;
  if (!w) {
    const fakeW = ttW(), mine = ents.find(e => e.id === f.car) || ents[0], sf = stratForm(fakeW, mine), N = raceLaps(fakeW), L = tyreKnowledge(fakeW, mine);
    S.ui.stratW = fakeW;
    h += `<section class="card"><h2>The session</h2><div class="metrics" style="align-items:end">
        <label class="field">Circuit${sel('tt-track', 'ui/form/tt/trackId', f.trackId, tracks.map(x => [x.id, x.name]))}</label>
        <label class="field">Session${sel('tt-session', 'ui/form/tt/session', f.session, [['gp', 'Grand Prix']].concat(t.hasSprint ? [['sprint', 'Sprint']] : []))}</label>
        <label class="field">Weather${sel('tt-weather', 'ui/form/tt/weatherMode', f.weatherMode, F1_WEATHER)}</label>
        <label class="field">Seed (optional)<input id="tt-seed" type="number" min="1" data-bind="ui/form/tt/seed" value="${esc(f.seed || '')}" placeholder="Random"></label></div>
      ${randomnessHtml('tt', f, t)}</section>
      <section class="card" style="--team:${esc(F1.team(mine.teamId).color)}"><h2>Your car</h2>
        <div class="metrics" style="align-items:end"><label class="field">Car${sel('tt-car', 'ui/form/tt/car', f.car, ents.map(e => [e.id, `${e.name}, ${F1.team(e.teamId).name}`]))}</label>
          <label class="field">Set-up quality (20 to 95)<input id="tt-setup" type="number" min="20" max="95" data-bind="ui/form/tt/setup" data-type="number" value="${esc(f.setup)}"></label></div>
        <p class="muted small">Tyre life here: ${['soft', 'medium', 'hard'].map(k => `${f1TyreChip(k)} about ${L[k].laps} laps`).join(' &nbsp; ')}. ${esc(forecastText(fakeW))}</p>
        ${presetBarHtml(mine, sf)}
        <div class="tabs" role="tablist">${PLAN_NAMES.map((n, i) => `<button role="tab" class="tab" data-act="strat-tab" data-car="${esc(mine.id)}" data-i="${i}" aria-selected="${(sf.tab || 0) === i}">${n}</button>`).join('')}</div>
        ${planEditorHtml(fakeW, mine, sf, sf.tab || 0, N, L)}
        <label class="field" style="max-width:240px">Start on${sel(`sp-${mine.id}-active`, `ui/form/strat/${mine.id}/active`, sf.active, PLAN_NAMES.map((n, i) => [String(i), n]))}</label>
        ${approachHtml(mine, sf)}${triggersEditorHtml(mine, sf, N)}
        <div class="btn-row"><button class="btn primary" data-act="tt-quali">Run qualifying</button></div></section>`;
    return h;
  }
  h += `<section class="card rc ${live ? 'is-live' : ''}"><h2>Controls ${live ? '<span class="tag live">Running</span>' : ''}</h2><div class="btn-row">
    ${w.state.finished ? '' : `<button class="btn primary" data-act="tt-play">${live ? 'Pause' : w.state.lap ? 'Resume' : 'Start the race'}</button>
      <label class="sr-only" for="tt-speed">Speed</label>${sel('tt-speed', 'ui/form/tt/speed', f.speed, [['2000', 'A lap every 2 seconds'], ['1000', 'A lap a second'], ['300', 'Fast']])}
      <button class="btn" data-act="tt-step" data-laps="1" ${live ? 'disabled' : ''}>Next lap</button><button class="btn" data-act="tt-step" data-laps="999" ${live ? 'disabled' : ''}>Run to the flag</button>
      <label class="small"><input type="checkbox" data-act="tt-stopsc" ${S.ui.form.ttStopSc !== false ? 'checked' : ''}> Pause for safety cars</label>`}
    <button class="btn" data-act="tt-reset">Back to set-up</button><button class="btn" data-act="tt-quali">Run it again (new seed unless set)</button></div>
    <p class="muted small">${esc(forecastText(w))}</p></section>`;
  if (w.state.lap > 0 && !w.state.finished) h += ttMomentHtml(w) + ttCarHtml(w);
  if (w.status === 'finished') h += `<section class="card"><h2>Classification</h2><div class="scroll-x">${f1ResultsHtml(w)}</div></section>`;
  const racing = w.state.lap > 0, tab = S.ui.f1tab && (racing || S.ui.f1tab === 'feed') ? S.ui.f1tab : 'feed';
  const tabs = [['feed', 'Race log'], ['lapchart', 'Lap chart'], ['tyres', 'Tyre strategy'], ['driver', S.ui.f1pick ? `Driver: ${S.ui.f1pick}` : 'Driver']].filter(x => racing || x[0] === 'feed');
  const body = tab === 'lapchart' ? lvLapChartHtml(w) : tab === 'tyres' ? f1ChartHtml(w) : tab === 'driver' ? lvDriverHtml(w) : f1FeedHtml(w);
  h += `<div class="f1-main"><section class="card"><h2>${racing ? 'Timing' : 'Qualifying'}</h2><div class="scroll-x">${lvTowerHtml(w)}</div></section>
    <section class="card"><div class="tabs" role="tablist">${tabs.map(([k, l]) => `<button role="tab" class="tab" data-act="f1-tab" data-tab="${k}" aria-selected="${tab === k}">${esc(l)}</button>`).join('')}</div>${body}</section></div>`;
  return h;
});

/* =====================================================================
   F1 SIM — series and seasons.
   The league can run several series side by side (Formula 1, Formula 2,
   Formula 3, or one built from scratch), each with its own teams, seats,
   drivers, calendar, race lengths, points, qualifying and rules. A switch
   in the top bar changes which series the whole site shows. Every race
   weekend belongs to a season of a series; Race Control catalogues a
   finished season into the archive and starts the next, choosing what
   carries over. Characters keep one set of ratings across every series
   and season, and can hold one seat in each series.
   Existing records with no series belong to Formula 1's first season.
   ===================================================================== */
'use strict';

const F1_POINTS = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1];
const SERIES_TEMPLATES = {
  f1: { name: 'Formula 1', short: 'F1', color: '#E10600', lapFactor: 1, sprintFactor: 0.33, points: F1_POINTS, sprintPoints: [8, 7, 6, 5, 4, 3, 2, 1], quali: 'knockout',
    development: true, puAllowance: 4, budget: 30, mandatoryStop: true, carsPerTeam: 2, firstSeason: '2026', blurb: 'Today’s grid, real teams, development and power units.' },
  f2: { name: 'Formula 2', short: 'F2', color: '#1B6FD1', lapFactor: 0.56, sprintFactor: 0.4, points: F1_POINTS, sprintPoints: [10, 8, 6, 5, 4, 3, 2, 1], quali: 'single', sprintEvery: true,
    development: false, puAllowance: null, budget: 6, mandatoryStop: true, carsPerTeam: 2, engine: 'Mecachrome V6 (spec)', level: 'feeder', firstSeason: '2026',
    blurb: 'Identical cars, a sprint and a feature race every round. The last step before F1.',
    teams: [['invicta', 'Invicta Racing', '#C9A227'], ['campos', 'Campos Racing', '#E4572E'], ['dams', 'DAMS', '#2D6FB7'], ['hitech', 'Hitech', '#9AA3AD'], ['art', 'ART Grand Prix', '#3D3D3D'],
      ['mp', 'MP Motorsport', '#F28C28'], ['prema', 'Prema Racing', '#D7263D'], ['rodin', 'Rodin Motorsport', '#4C9A2A'], ['aix', 'AIX Racing', '#7A4FBF'], ['trident', 'Trident', '#1F3A93'], ['var', 'Van Amersfoort Racing', '#E6194B']],
    calendar: ['australia', 'bahrain', 'saudi', 'monaco', 'spain', 'austria', 'britain', 'belgium', 'hungary', 'italy', 'azerbaijan', 'qatar', 'abudhabi'] },
  f3: { name: 'Formula 3', short: 'F3', color: '#2FA84F', lapFactor: 0.45, sprintFactor: 0.37, points: F1_POINTS, sprintPoints: [10, 9, 8, 7, 6, 5, 4, 3, 2, 1], quali: 'single', sprintEvery: true,
    development: false, puAllowance: null, budget: 3, mandatoryStop: false, carsPerTeam: 3, engine: 'Mecachrome (spec)', level: 'junior', firstSeason: '2026',
    blurb: 'Thirty cars, three per team, no pit stops. Where careers start.',
    teams: [['prema', 'Prema Racing', '#D7263D'], ['trident', 'Trident', '#1F3A93'], ['art', 'ART Grand Prix', '#3D3D3D'], ['mp', 'MP Motorsport', '#F28C28'], ['hitech', 'Hitech', '#9AA3AD'],
      ['campos', 'Campos Racing', '#E4572E'], ['rodin', 'Rodin Motorsport', '#4C9A2A'], ['aix', 'AIX Racing', '#7A4FBF'], ['var', 'Van Amersfoort Racing', '#E6194B'], ['dams', 'DAMS', '#2D6FB7']],
    calendar: ['australia', 'bahrain', 'monaco', 'spain', 'austria', 'britain', 'belgium', 'hungary', 'italy'] }
};
const LEVELS = { elite: { base: 82, spread: 14 }, feeder: { base: 73, spread: 14 }, junior: { base: 64, spread: 16 } };
const FIRST = ['Mateo', 'Elena', 'Jonas', 'Aiko', 'Rafael', 'Nora', 'Kai', 'Lucía', 'Theo', 'Ines', 'Ravi', 'Maja', 'Oscar', 'Leila', 'Arlo', 'Sofia', 'Hugo', 'Ama', 'Niko', 'Freya', 'Dario', 'Yuki', 'Cian', 'Mira', 'Emil', 'Zara', 'Luca', 'Ines', 'Tomás', 'Hana', 'Ezra', 'Aoife'];
const LAST = ['Varga', 'Lindholm', 'Okafor', 'Castell', 'Brandt', 'Moreau', 'Sato', 'Delgado', 'Kowalski', 'Hallberg', 'Ferreira', 'Novak', 'Achterberg', 'Rossi-Lane', 'MacAulay', 'Petrov', 'Haddad', 'Quinlan', 'Jensen', 'Abara', 'Silvestri', 'Takeda', 'Laurent', 'Mbeki', 'Ortega', 'Halvorsen', 'Duarte', 'Kerrigan', 'Vasquez', 'Ilić', 'Brennan', 'Asante'];
const TEAM_WORDS = ['Aurora', 'Kestrel', 'Meridian', 'Halcyon', 'Vanguard', 'Ironbridge', 'Solent', 'Corsa', 'Northwind', 'Cobalt', 'Granite', 'Arrowfield', 'Lumen', 'Torque', 'Saltire', 'Pinnacle'];
const TEAM_COLOURS = ['#E4572E', '#2D6FB7', '#4C9A2A', '#C9A227', '#7A4FBF', '#D7263D', '#1F3A93', '#F28C28', '#118A7E', '#9AA3AD', '#B5179E', '#3D3D3D', '#E6194B', '#6C8EAD', '#8D6E63', '#00A6A6'];

/* ---------------------------------------------------------------- the current series and season */
const curSeriesId = () => S.series || 'f1';
function seriesDoc(id) {
  const d = get('f1_series', id), tpl = SERIES_TEMPLATES[(d && d.template) || id] || SERIES_TEMPLATES.f1;
  return Object.assign({}, tpl, d || {}, { id });
}
const curSeries = () => seriesDoc(curSeriesId());
function allSeries() {
  const ids = new Set(list('f1_series').map(s => s.id)); if (list('f1_teams').some(t => (t.seriesId || 'f1') === 'f1')) ids.add('f1');
  return [...ids].map(seriesDoc).sort((a, b) => (a.order || (a.id === 'f1' ? 0 : a.id === 'f2' ? 1 : a.id === 'f3' ? 2 : 9)) - (b.order || (b.id === 'f1' ? 0 : b.id === 'f2' ? 1 : b.id === 'f3' ? 2 : 9)));
}
const curSeasonId = sid => seriesDoc(sid || curSeriesId()).activeSeason || `${sid || curSeriesId()}-1`;
function seasonDoc(id) {
  const d = get('f1_seasons', id); if (d) return d;
  const sid = id.slice(0, id.lastIndexOf('-')), s = seriesDoc(sid);
  return { id, seriesId: sid, name: s.firstSeason || '2026', status: 'active', implicit: true };
}
const curSeason = () => seasonDoc(curSeasonId());
const seasonClosed = () => curSeason().status === 'archived';
const wSeries = w => w.seriesId || 'f1';
const wSeason = w => w.seasonId || `${wSeries(w)}-1`;
const recSeason = x => x.seasonId || `${(F1.team(x.teamId) || {}).seriesId || 'f1'}-1`;
function adjustTrack(t, s, round) {
  return Object.assign({}, t, { round, laps: Math.max(5, Math.round(t.laps * (s.lapFactor || 1))), sprintLaps: Math.max(4, Math.round(t.laps * (s.sprintFactor || 0.33))), hasSprint: s.sprintEvery ? true : t.hasSprint });
}
/* The rest of the app reads everything through these, so the whole site follows the series switch. */
Object.assign(F1, {
  teams: () => list('f1_teams').filter(t => (t.seriesId || 'f1') === curSeriesId()).sort((a, b) => (a.order || 0) - (b.order || 0)),
  seats: teamId => { const ids = teamId ? null : new Set(F1.teams().map(t => t.id)); return list('f1_seats').filter(s => teamId ? s.teamId === teamId : ids.has(s.teamId)).sort((a, b) => (a.order || 0) - (b.order || 0)); },
  tracks: () => { const s = curSeries(), all = list('f1_tracks').sort((a, b) => (a.round || 0) - (b.round || 0)), cal = s.calendar;
    return (cal && cal.length ? cal.map(id => all.find(t => t.id === id)).filter(Boolean) : all).map((t, i) => adjustTrack(t, s, i + 1)); },
  track: id => { const t = get('f1_tracks', id); if (!t) return null; const s = curSeries(), cal = s.calendar || [], i = cal.indexOf(id); return adjustTrack(t, s, cal.length ? (i >= 0 ? i + 1 : '') : t.round); },
  weekends: () => list('f1_weekends').filter(w => wSeries(w) === curSeriesId() && wSeason(w) === curSeasonId()).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))),
  allWeekends: () => list('f1_weekends').sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))),
  live: () => F1.weekends().find(w => w.status !== 'finished') || null
});
CHANGES['series-switch'] = v => { S.series = v; lsSet('f1sim.series', v); S.ui.teamId = null; S.ui.f1view = null; S.tt.cfg = null; S.tt.w = null; S.ui.form.f1w = null; render(); };
(function () { const saved = lsGet('f1sim.series'); if (saved) S.series = saved; })();
function seriesSwitchHtml() {
  const all = allSeries(); if (all.length < 2) return '';
  return `<label class="series-pick"><span class="sr-only">Series</span><select id="series-switch" data-change="series-switch" style="--series:${esc(curSeries().color)}">${all.map(s => `<option value="${esc(s.id)}" ${s.id === curSeriesId() ? 'selected' : ''}>${esc(s.short)}: ${esc(s.name)}</option>`).join('')}</select></label>`;
}

/* ---------------------------------------------------------------- the series' own rules, in the race */
function seriesRules(s) {
  const out = { points: s.points || F1_POINTS, sprintPoints: s.sprintPoints, mandatoryCompounds: s.mandatoryStop !== false };
  if (s.quali === 'single') out.qualifying = { q2: 99, q3: 99 };
  return out;
}

/* ---------------------------------------------------------------- loading a series */
function genPerson(id, rng, lvl, extra) {
  const L = LEVELS[lvl] || LEVELS.feeder, r = () => L.base + Math.floor(rng() * L.spread);
  const first = FIRST[Math.floor(rng() * FIRST.length)], last = LAST[Math.floor(rng() * LAST.length)];
  const styles = ['charger', 'aggressive', 'qualifier', 'technical', 'smooth', 'defender', 'strategist', 'ironman'];
  return Object.assign({ id, kind: 'driver', fictional: true, name: `${first} ${last}`, abbr: last.normalize('NFD').replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase(),
    pace: r(), consistency: r(), wet: r(), overtaking: r(), defense: r(), experience: Math.max(10, L.base - 50 + Math.floor(rng() * 30)), mental: 4 + Math.floor(rng() * 6),
    style: styles[Math.floor(rng() * styles.length)], goodTracks: [], badTracks: [], rivals: [] }, extra || {});
}
/* Rows to write for a series made from a template (or a custom one): series, season, teams, seats, people. */
function seriesRows(key, opts) {
  opts = opts || {};
  const tpl = SERIES_TEMPLATES[opts.template || key], rows = [], rng = RaceEngine.rng(h32('series', key, opts.name || '')), cars = Number(opts.carsPerTeam) || tpl.carsPerTeam || 2;
  const teamList = opts.teams || tpl.teams || [];
  const doc = Object.assign({ template: opts.template || key, activeSeason: `${key}-1` }, opts.name ? { name: opts.name, short: opts.short, color: opts.color, carsPerTeam: cars, level: opts.level || tpl.level } : {});
  if (key !== 'f1' || opts.template) rows.push(['f1_series', key, doc]);
  const archs = ['one_stop', 'aggressive_two', 'undercut_king', 'overcut', 'reactive', 'tyre_banker', 'safety_car'];
  teamList.forEach(([slug, name, color], ti) => {
    const id = `${key}-${slug}`, base = tpl.development ? 80 + Math.round(rng() * 10) : 82;
    rows.push(['f1_teams', id, { seriesId: key, name, color, order: ti + 1, powerUnit: tpl.engine || 'Customer', strategy: archs[Math.floor(rng() * archs.length)],
      carPace: base, topSpeed: tpl.development ? 10 + Math.round(rng() * 6) : 12, cornering: tpl.development ? 10 + Math.round(rng() * 6) : 12,
      reliability: 86 + Math.round(rng() * 8), pitSpeed: 80 + Math.round(rng() * 12), tyreLife: 72 + Math.round(rng() * 8) }]);
    const tp = genPerson(`${key}-tp-${slug}`, rng, 'elite', { kind: 'principal', seriesId: key, teamId: id }); rows.push(['f1_people', tp.id, tp]);
    const seat = (k, role, car, order, def) => rows.push(['f1_seats', `${id}-${k}`, { teamId: id, role, car, order: ti * 10 + order, defaultPersonId: def || null, holderCharId: null, holderName: null, holderSince: null, open: true }]);
    seat('tp', 'principal', null, 0, tp.id);
    for (let c = 1; c <= cars; c++) {
      const p = genPerson(`${key}-drv-${slug}-${c}`, rng, opts.level || tpl.level || 'feeder', { seriesId: key, teamId: id, num: ti * cars + c + 1 }); rows.push(['f1_people', p.id, p]);
      seat('d' + c, 'driver', c, c * 2 - 1, p.id); seat('e' + c, 'engineer', c, c * 2, null);
    }
  });
  if (!list('f1_tracks').length) F1_DEFAULTS.tracks.forEach(t => rows.push(['f1_tracks', t.id, Object.assign({}, t)]));
  return rows;
}
ACTIONS['series-add'] = d => {
  const tpl = SERIES_TEMPLATES[d.key]; if (!tpl) return;
  if (get('f1_series', d.key)) { toast(`${tpl.name} is already set up.`, true); return; }
  askConfirm(`Set up ${tpl.name}: ${tpl.teams.length} teams with ${tpl.carsPerTeam} cars each, fictional drivers to start with, and a ${tpl.calendar.length}-round calendar? Players’ characters can then take seats in it.`, `Set up ${tpl.short}`, () => run(async () => {
    await f1PutAll(seriesRows(d.key)); await Data.audit('series.add', `${tpl.name} set up`);
  }, `${tpl.name} is ready. Switch to it in the top bar.`));
};
ACTIONS['series-custom'] = () => {
  const f = S.ui.form.newSeries || {}, name = String(f.name || '').trim(), short = String(f.short || '').trim().toUpperCase().slice(0, 4);
  if (!name || !short) { toast('Give the series a name and a short code.', true); return; }
  const key = 'cx-' + short.toLowerCase().replace(/[^a-z0-9]/g, ''); if (get('f1_series', key)) { toast('There’s already a series with that code.', true); return; }
  const n = Math.max(4, Math.min(14, Number(f.teams) || 8)), rng = RaceEngine.rng(h32('custom', key)), words = TEAM_WORDS.slice().sort(() => rng() - 0.5);
  const teams = words.slice(0, n).map((w, i) => [w.toLowerCase(), `${w} ${['Racing', 'Motorsport', 'GP', 'Racing Team'][i % 4]}`, TEAM_COLOURS[i % TEAM_COLOURS.length]]);
  const tpl = SERIES_TEMPLATES[f.template || 'f2'], opts = { template: f.template || 'f2', name, short, color: f.color || '#7A4FBF', carsPerTeam: Number(f.cars) || 2, level: f.level || 'feeder', teams };
  run(async () => { const rows = seriesRows(key, opts); rows.find(r => r[0] === 'f1_series')[2].calendar = (tpl.calendar || F1_DEFAULTS.tracks.map(t => t.id)).slice(0, 10);
    await f1PutAll(rows); await Data.audit('series.add', `${name} set up`); S.ui.form.newSeries = {}; }, `${name} is ready. Switch to it in the top bar, then rename its teams from The Grid (the Car button).`);
};
ACTIONS['calendar-save'] = () => {
  const s = curSeries(), pick = S.ui.form.cal || {}, ids = list('f1_tracks').sort((a, b) => (a.round || 0) - (b.round || 0)).map(t => t.id).filter(id => pick[id]);
  if (ids.length < 1) { toast('Pick at least one circuit.', true); return; }
  run(async () => { await Data.put('f1_series', s.id, Object.assign(get('f1_series', s.id) ? clone(S.store.f1_series[s.id]) : { template: s.id, activeSeason: curSeasonId() }, { calendar: ids })); }, `${s.name}’s calendar saved: ${plural(ids.length, 'round')}.`);
};

/* ---------------------------------------------------------------- standings for any season */
function standingsOf(weekends) {
  const drivers = new Map(), teams = new Map();
  weekends.filter(w => w.status === 'finished').slice().sort((a, b) => String(a.finishedAt).localeCompare(String(b.finishedAt))).forEach(w => (w.results || []).forEach(r => {
    const d = drivers.get(r.personId) || { personId: r.personId, name: r.name, teamId: r.teamId, charId: r.charId, pts: 0, wins: 0, podiums: 0, starts: 0, best: 99 };
    d.pts += r.points || 0; d.starts += 1; d.teamId = r.teamId; d.name = r.name;
    if (r.position) { if (r.position === 1 && w.session !== 'sprint') d.wins += 1; if (r.position <= 3 && w.session !== 'sprint') d.podiums += 1; d.best = Math.min(d.best, r.position); }
    drivers.set(r.personId, d);
    const t = teams.get(r.teamId) || { teamId: r.teamId, name: (get('f1_teams', r.teamId) || {}).name || r.teamId, pts: 0, wins: 0 }; t.pts += r.points || 0; if (w.session !== 'sprint' && r.position === 1) t.wins += 1; teams.set(r.teamId, t);
  }));
  const order = (a, b) => b.pts - a.pts || b.wins - a.wins || (a.best || 99) - (b.best || 99);
  return { drivers: [...drivers.values()].sort(order), teams: [...teams.values()].sort(order) };
}
const seasonWeekendsOf = (seriesId, seasonId) => list('f1_weekends').filter(w => wSeries(w) === seriesId && wSeason(w) === seasonId);

/* ---------------------------------------------------------------- cataloguing a season, starting the next */
ACTIONS['season-end'] = () => {
  const s = curSeries(), season = curSeason(); if (season.status === 'archived') return;
  if (F1.live()) { toast('Finish or cancel the open weekend first.', true); return; }
  const ws = seasonWeekendsOf(s.id, season.id).filter(w => w.status === 'finished'), st = standingsOf(ws);
  askConfirm(`Catalogue ${s.name}’s ${season.name} season? Its ${plural(ws.length, 'race')}, standings and champions go into the archive, and no more weekends can be opened until you start the next season.`, 'Catalogue the season', () => run(async () => {
    const snap = { drivers: st.drivers.map(d => ({ personId: d.personId, name: d.name, teamId: d.teamId, teamName: (get('f1_teams', d.teamId) || {}).name || '', charId: d.charId || null, pts: d.pts, wins: d.wins, podiums: d.podiums })),
      teams: st.teams.map(t => ({ teamId: t.teamId, name: t.name, pts: t.pts, wins: t.wins })), races: ws.filter(w => w.session === 'gp').length, sprints: ws.filter(w => w.session === 'sprint').length };
    /* Keep what's already on the season (its engine rules, say). */
    const was = get('f1_seasons', season.id) ? clone(S.store.f1_seasons[season.id]) : {};
    await Data.put('f1_seasons', season.id, Object.assign(was, { seriesId: s.id, name: season.name, status: 'archived', startedAt: season.startedAt || (ws[ws.length - 1] || {}).createdAt || null, endedAt: nowIso(), archive: snap }));
    await Data.audit('season.end', `${s.name} ${season.name} catalogued: ${snap.drivers[0] ? snap.drivers[0].name + ' champion' : 'no races'}`);
  }, `${season.name} catalogued. Start the next season when you’re ready.`), true);
};
ACTIONS['season-start'] = () => {
  const s = curSeries(), prev = curSeason(), f = S.ui.form.newSeason || {}, name = String(f.name || '').trim() || String((Number(prev.name) || 2026) + 1);
  if (prev.status !== 'archived') { toast('Catalogue the current season first.', true); return; }
  const n = Number(String(prev.id).split('-').pop()) + 1, id = `${s.id}-${n}`, carry = Number(f.carry == null ? 0.5 : f.carry), keep = f.keepSeats !== false;
  run(async () => {
    /* Car development carries over in part: each team's base moves towards where its car finished the season. */
    if (carry > 0 && s.development) for (const t of F1.teams()) {
      /* Only development carries over, not the engine's effect (next season's engine applies on top). */
      const eff = f1EffectiveTeam(t, finishedGps().length), withEngine = engineApply(t, Object.assign({}, t)), doc = clone(S.store.f1_teams[t.id]);
      ['carPace', 'topSpeed', 'cornering', 'reliability', 'tyreLife', 'pitSpeed'].forEach(k => { if (eff[k] != null && t[k] != null) { const dev = (eff[k] - ((withEngine[k] || 0) - (t[k] || 0))) - t[k]; doc[k] = Math.round((t[k] + dev * carry) * 100) / 100; } });
      await Data.put('f1_teams', t.id, doc);
    }
    if (!keep) for (const seat of F1.seats().filter(x => x.holderCharId)) await Data.put('f1_seats', seat.id, Object.assign(clone(S.store.f1_seats[seat.id]), { holderCharId: null, holderName: null, holderSince: null }));
    const pe = engineConfig(s.id, prev.id), nf = ENGINE_FORMULAS[f.engine] ? f.engine : pe.formula;
    await Data.put('f1_seasons', id, { seriesId: s.id, name, status: 'active', startedAt: nowIso(), carry, keptSeats: keep, engine: { formula: nf, teams: pe.teams, ratings: nf === pe.formula ? pe.ratings : {}, seed: 0 } });
    await Data.put('f1_series', s.id, Object.assign(get('f1_series', s.id) ? clone(S.store.f1_series[s.id]) : { template: s.id }, { activeSeason: id }));
    await Data.audit('season.start', `${s.name} ${name} season started`);
    S.ui.form.newSeason = {};
  }, `${s.name} ${name} has started. Budgets, upgrades, power units, sponsors and contracts start fresh; drivers keep their ratings and careers.`);
};

/* ---------------------------------------------------------------- Seasons page (everyone; Race Control acts here) */
function archiveHtml(season) {
  const a = season.archive || { drivers: [], teams: [] }, champ = a.drivers[0], cons = a.teams[0];
  const ws = seasonWeekendsOf(season.seriesId, season.id).filter(w => w.status === 'finished').sort((x, y) => String(x.finishedAt).localeCompare(String(y.finishedAt)));
  return `<section class="card season-card"><h2>${esc(season.name)} <span class="sub">${plural(a.races || 0, 'Grand Prix', 'Grands Prix')}${a.sprints ? `, ${plural(a.sprints, 'sprint')}` : ''}. Catalogued ${esc(fmtDate(season.endedAt))}.</span></h2>
    ${champ ? `<p class="champ"><span class="tag trophy">Champion</span> <b>${careerLink(champ.personId, champ.name)}</b>, ${esc(champ.teamName)}, ${champ.pts} points${cons ? `. <span class="tag trophy">Teams’ champions</span> <b>${esc(cons.name)}</b>, ${cons.pts} points` : ''}.</p>` : '<p class="muted">No races were run.</p>'}
    <details><summary>Final standings</summary><div class="cols2"><table class="data compact"><thead><tr><th>Pos</th><th>Driver</th><th>Team</th><th class="num">Points</th></tr></thead><tbody>${a.drivers.map((d, i) => `<tr><td>${i + 1}</td><td>${careerLink(d.personId, d.name)}${d.charId ? ' <span class="tag player">Player</span>' : ''}</td><td>${esc(d.teamName)}</td><td class="num">${d.pts}</td></tr>`).join('')}</tbody></table>
      <table class="data compact"><thead><tr><th>Pos</th><th>Team</th><th class="num">Points</th></tr></thead><tbody>${a.teams.map((t, i) => `<tr><td>${i + 1}</td><td>${esc(t.name)}</td><td class="num">${t.pts}</td></tr>`).join('')}</tbody></table></div></details>
    ${ws.length ? `<details><summary>Every result</summary><table class="data compact"><tbody>${ws.map(w => { const t = get('f1_tracks', w.trackId) || {}, win = (w.results || [])[0] || {};
      return `<tr><td>${esc(t.name || w.trackId)}${w.session === 'sprint' ? ' sprint' : ''}</td><td>${esc(win.name || '')}</td><td class="num"><button class="btn small" data-act="f1-view" data-id="${esc(w.id)}" data-go="weekend">View</button></td></tr>`; }).join('')}</tbody></table></details>` : ''}</section>`;
}
route('seasons', 'Seasons', function () {
  const s = curSeries(), season = curSeason(), ws = F1.weekends(), done = ws.filter(w => w.status === 'finished'), st = standingsOf(done), lead = st.drivers[0];
  const archived = list('f1_seasons').filter(x => x.seriesId === s.id && x.status === 'archived').sort((a, b) => String(b.endedAt).localeCompare(String(a.endedAt)));
  const f = S.ui.form.newSeason = S.ui.form.newSeason || {};
  let h = `<div class="page-head"><div><p class="eyebrow">${esc(s.name)}</p><h1>Seasons</h1><p>The current season, and every one catalogued before it.</p></div></div>`;
  if (season.status !== 'archived') h += `<section class="card" style="--team:${esc(s.color)}"><h2>${esc(season.name)} <span class="sub">In progress</span></h2>
    <p>${plural(done.filter(w => w.session === 'gp').length, 'Grand Prix', 'Grands Prix')} run of ${F1.tracks().length} rounds.${lead ? ` ${careerLink(lead.personId, lead.name)} leads with ${lead.pts} points.` : ''}</p>
    ${S.isGm ? `<div class="btn-row"><button class="btn" data-act="season-end">Catalogue the season</button></div><p class="muted small">Do this after the last round. The season’s results and champions go into the archive; then you start the next one.</p>` : ''}</section>`;
  else h += `<section class="card"><h2>Between seasons</h2><p>${esc(season.name)} is catalogued. ${S.isGm ? 'Start the next season to open weekends again.' : 'Race Control will start the next season soon.'}</p>
    ${S.isGm ? `<div class="metrics" style="align-items:end"><label class="field">Season name<input id="ns-name" type="text" data-bind="ui/form/newSeason/name" value="${esc(f.name || String((Number(season.name) || 2026) + 1))}"></label>
      ${s.development ? `<label class="field">Car development carried over${sel('ns-carry', 'ui/form/newSeason/carry', String(f.carry == null ? '0.5' : f.carry), [['0', 'None: back to base'], ['0.5', 'Half of it'], ['1', 'All of it']])}</label>` : ''}</div>
      <label class="field" style="max-width:420px">Engines${sel('ns-engine', 'ui/form/newSeason/engine', f.engine || engineConfig().formula, ENGINE_ORDER.map(k => [k, ENGINE_FORMULAS[k].label]))}</label>
      <label class="small"><input type="checkbox" data-bind="ui/form/newSeason/keepSeats" ${f.keepSeats !== false ? 'checked' : ''}> Players keep their seats</label>
      <p class="muted small">Budgets, upgrades in progress, power units, sponsors and contracts start fresh. Drivers keep their ratings, development and careers.</p>
      <div class="btn-row"><button class="btn primary" data-act="season-start">Start the new season</button></div>` : ''}</section>`;
  if (season.status !== 'archived') h += engineCardHtml();
  h += archived.length ? archived.map(archiveHtml).join('') : '<p class="muted">No seasons catalogued yet.</p>';
  return h;
});

/* ---------------------------------------------------------------- Series page (Race Control) */
route('series', 'Series', function () {
  const all = allSeries(), cur = curSeries(), tracks = list('f1_tracks').sort((a, b) => (a.round || 0) - (b.round || 0));
  const cal = S.ui.form.cal = S.ui.form.cal && S.ui.form.calFor === cur.id ? S.ui.form.cal : Object.fromEntries((cur.calendar && cur.calendar.length ? cur.calendar : tracks.map(t => t.id)).map(id => [id, true]));
  S.ui.form.calFor = cur.id;
  const nf = S.ui.form.newSeries = S.ui.form.newSeries || { template: 'f2', teams: 8, cars: 2, level: 'feeder', color: '#7A4FBF' };
  return `<div class="page-head"><div><h1>Series</h1><p>Run several series side by side. Each has its own teams, seats, calendar, points and rules; characters can hold one seat in each, and keep their ratings everywhere.</p></div></div>
    <section class="card"><h2>Running now</h2><table class="data"><tbody>${all.map(s => `<tr><td><span class="f1-bar" style="background:${esc(s.color)}"></span><b>${esc(s.name)}</b> <span class="muted">${esc(s.short)}</span></td>
      <td>${esc(seasonDoc(curSeasonId(s.id)).name)} season${seasonDoc(curSeasonId(s.id)).status === 'archived' ? ' (catalogued)' : ''}</td><td class="muted small">${esc(s.blurb || '')}</td></tr>`).join('')}</tbody></table></section>
    <section class="card"><h2>Add a series</h2><div class="cards">${Object.keys(SERIES_TEMPLATES).filter(k => k !== 'f1' && !get('f1_series', k)).map(k => { const t = SERIES_TEMPLATES[k];
      return `<article class="card" style="--team:${esc(t.color)}"><h3>${esc(t.name)}</h3><p>${esc(t.blurb)}</p><p class="muted small">${t.teams.length} teams, ${t.carsPerTeam} cars each. ${t.quali === 'single' ? 'One qualifying session.' : ''} ${t.mandatoryStop ? 'A pit stop is required.' : 'No pit stops.'} Races ${Math.round(t.lapFactor * 100)}% of F1 distance; sprints too.</p>
        <button class="btn small primary" data-act="series-add" data-key="${k}">Set up ${esc(t.short)}</button></article>`; }).join('') || '<p class="muted">Formula 2 and Formula 3 are set up.</p>'}</div>
      <h3 style="margin-top:16px">Or build your own</h3><div class="form-grid">
        <label class="field">Name<input id="ns-n" type="text" data-bind="ui/form/newSeries/name" value="${esc(nf.name || '')}" placeholder="e.g. Saltire Formula Cup"></label>
        <label class="field">Short code<input id="ns-s" type="text" maxlength="4" data-bind="ui/form/newSeries/short" value="${esc(nf.short || '')}" placeholder="e.g. SFC"></label>
        <label class="field">Rules like${sel('ns-t', 'ui/form/newSeries/template', nf.template, [['f1', 'Formula 1: development, power units'], ['f2', 'Formula 2: spec cars, sprint and feature'], ['f3', 'Formula 3: spec cars, no pit stops']])}</label>
        <label class="field">Driver standard${sel('ns-l', 'ui/form/newSeries/level', nf.level, [['elite', 'Elite'], ['feeder', 'Feeder series'], ['junior', 'Junior']])}</label>
        <label class="field">Teams (4 to 14)<input id="ns-tm" type="number" min="4" max="14" data-bind="ui/form/newSeries/teams" data-type="number" value="${esc(nf.teams)}"></label>
        <label class="field">Cars per team${sel('ns-c', 'ui/form/newSeries/cars', String(nf.cars), [['2', 'Two'], ['3', 'Three']])}</label>
        <label class="field">Colour<input id="ns-col" type="color" data-bind="ui/form/newSeries/color" value="${esc(nf.color)}"></label></div>
      <div class="btn-row"><button class="btn primary" data-act="series-custom">Create the series</button></div>
      <p class="muted small">Custom series start with fictional teams and drivers; rename teams and tune their cars from The Grid.</p></section>
    <section class="card"><h2>${esc(cur.name)} calendar</h2><p class="muted small">Tick the circuits this series visits, in calendar order. Race lengths follow the series’ rules.</p>
      <div class="cal-grid">${tracks.map(t => `<label class="small"><input type="checkbox" data-bind="ui/form/cal/${esc(t.id)}" ${cal[t.id] ? 'checked' : ''}> ${esc(t.flag || '')} ${esc(t.name)}</label>`).join('')}</div>
      <div class="btn-row"><button class="btn primary" data-act="calendar-save">Save the calendar</button></div></section>`;
}, { gm: true });

/* =====================================================================
   F1 SIM — practice sessions, set-up guidance and debriefs.
   Each driving style wants something different from the car, so the
   ideal set-up is the team's (from the circuit and car) moved by the
   driver's style. The set-up guide says what the circuit rewards, what
   the driver likes, and the engineer's best guess so far, which sharpens
   with each session, the driver's experience and rapport.
   A Grand Prix weekend has three practice sessions (sprint weekends and
   one-session series have one), each with its own runs. Race Control
   ends each session: everyone gets the timesheet, and each player's car
   a debrief. Confidence at the circuit builds through practice and is
   worth up to two tenths a lap in qualifying and the race. After
   qualifying, a debrief breaks down the gap and looks ahead to the race.
   ===================================================================== */
'use strict';

const CONF_MAX = 0.2;        // seconds a lap: full confidence against none
const AI_CONF = 0.5;         // cars nobody plays run a normal programme
const STYLE_PREF = {
  charger: { wing: 6, susp: 8, diff: 6, likes: 'a pointy, responsive car: a little more wing and a stiffer platform than most, with the diff fairly locked to fire out of corners', hates: 'understeer: if the front won’t bite, the confidence goes' },
  aggressive: { wing: 4, susp: 6, diff: 8, likes: 'a stiff car with a locked diff, to throw it at the kerbs and get on the power early', hates: 'a lazy car that won’t change direction' },
  qualifier: { wing: 6, susp: 4, diff: 0, likes: 'maximum grip over one lap: more wing and a slightly stiffer car', hates: 'running light: give up a little straight-line speed for corner speed' },
  smooth: { wing: -2, susp: -8, diff: -6, likes: 'a soft, progressive car with an open diff, kind to the tyres', hates: 'a snappy rear end on the throttle' },
  defender: { wing: -4, susp: 0, diff: 4, likes: 'straight-line speed to stay out of reach: a little less wing than most', hates: 'being a sitting duck on the straights' },
  technical: { wing: 0, susp: 0, diff: 0, likes: 'whatever is fastest: technical drivers adapt, and their feedback is precise', hates: 'a car that’s out of balance' },
  strategist: { wing: 0, susp: -4, diff: -4, likes: 'a car that looks after its tyres: slightly softer, with an open diff', hates: 'a car that chews through the rears' },
  ironman: { wing: 2, susp: 2, diff: 0, likes: 'a stable, predictable car to rely on lap after lap', hates: 'a car that’s on a knife edge' }
};
const TYPE_TEXT = {
  'low-downforce': 'Long straights. Run low downforce and a fairly stiff car; top speed matters more than corner grip.',
  'high-speed': 'Fast, flowing corners. Medium-low downforce and a stiff car to keep it stable at speed.',
  mixed: 'A bit of everything. Middling downforce and a balanced, middle-of-the-range suspension.',
  technical: 'Lots of medium and slow corners. More downforce and a slightly softer car for the traction zones.',
  'high-downforce': 'Grip is everything. Plenty of downforce and medium suspension.',
  street: 'Bumpy, tight and walled in. Maximum downforce and a soft car to ride the bumps and kerbs.'
};
const styleOf = ent => (ent && ent.v3 && ent.v3.style) || ((f1Entrants().find(x => x.id === (ent && ent.id)) || {}).v3 || {}).style || 'technical';
const styleName = k => (F1_STYLES.find(s => s[0] === k) || ['', k])[1];
/* The set-up this car wants: the team's ideal, moved by its driver's style. */
function f1IdealFor(w, ent) {
  const i = f1Ideal(w, ent.teamId), p = STYLE_PREF[styleOf(ent)] || STYLE_PREF.technical;
  return { wing: clampN(i.wing + p.wing, 5, 95), susp: clampN(i.susp + p.susp, 5, 95), diff: clampN(i.diff + p.diff, 5, 95) };
}

/* ---------------------------------------------------------------- sessions */
const sessionsOf = w => w.session === 'test' ? 3 : w.session === 'sprint' || seriesDoc(wSeries(w)).quali === 'single' ? 1 : 3;
const runsPerSession = w => w.session === 'test' ? 6 : sessionsOf(w) === 1 ? 4 : 2;
const curSession = w => Math.min(sessionsOf(w), ((w.practice && w.practice.session) || 1));
const sessionName = (w, n) => w.session === 'test' ? `Day ${n}` : sessionsOf(w) === 1 ? 'Practice' : `FP${n}`;
const endedSessions = w => (w.practice && w.practice.done) || [];
const runsIn = (w, carId, n) => f1Runs(w, carId).filter(r => (r.session || 1) === n);
/* Can a player work on this car? Otherwise it runs a normal programme. */
const playerRun = (w, ent) => F1.seats(ent.teamId).some(s => s.holderCharId && (s.role === 'principal' || (s.car === ent.car && (s.role === 'engineer' || s.role === 'driver'))));
function bestSetupIn(w, ent, runs) {
  /* Only runs that happened count; a set-up found on a wet track is only half trusted. */
  return runs.filter(r => r.kind === 'setup').map(r => ({ r, ctx: runContext(w, r) })).filter(x => !x.ctx || x.ctx.cond)
    .reduce((b, x) => { const wet = !!(x.ctx && x.ctx.cond !== 'dry'), q = f1SetupQuality(w, ent.teamId, x.r.dials, ent), score = wet ? 60 + (q - 60) / 2 : q; return !b || score > b.score ? { q, r: x.r, wet, score } : b; }, null);
}
/* Confidence at this circuit, 0 to 1: built session by session, more with a set-up the driver likes. */
function confidenceAfter(w, ent, upTo) {
  if (!playerRun(w, ent)) return AI_CONF;
  const per = 3 / sessionsOf(w); let c = 0;
  for (let n = 1; n <= upTo; n++) { const runs = runsIn(w, ent.id, n).filter(r => { const x = runContext(w, r); return !x || x.cond; }), rec = endedSessions(w).find(s => s.n === n);
    if (rec && (rec.crashes || []).indexOf(ent.id) !== -1) c -= 0.15;
    if (!runs.length) continue;
    const b = bestSetupIn(w, ent, runs), close = b ? clampN((b.score - 60) / 35, 0, 1) : 0; c += (0.2 + 0.15 * close) * per; }
  c = Math.max(0, c);
  return Math.min(1, Math.round(c * 100) / 100);
}
const confidenceNow = (w, ent) => confidenceAfter(w, ent, w.status === 'practice' ? endedSessions(w).length : sessionsOf(w));

/* The timesheet when a session ends. Players' cars use their runs; the rest run a normal programme. */
function sessionTimes(w, n, rec) {
  const track = F1.track(w.trackId), circuit = FormulaRacingAdapter.toCircuit(track), teams = F1.teams().map(t => f1EffectiveTeam(t)), ents = f1Entrants();
  const entries = FormulaRacingAdapter.toEntries(ents.map(e => e.v3), teams, track, {}), out = {};
  ents.forEach((e, i) => {
    const en = entries[i], r = RaceEngine.rng(h32(w.seed, 'fp', n, e.id));
    if (playerRun(w, e)) { const rs = runsIn(w, e.id, n).map(x => f1RunResult(w, e, x)), laps = rs.filter(x => x.lap && !x.compound).map(x => x.lap);
      const longs = rs.filter(x => x.compound && x.lap).map(x => x.lap + 1.5);
      const best = Math.min(...laps.concat(longs)); out[e.id] = isFinite(best) ? Math.round(best * 1000) / 1000 : null; return; }
    /* Long runs early in the weekend; the last session ends with low-fuel qualifying runs, like the players' qualifying simulations. */
    if (rec) { const t = aiSessionLap(w, n, e, en, rec); out[e.id] = t == null ? null : Math.round(t * 1000) / 1000; return; }
    const prog = n === sessionsOf(w) ? -RaceEngine.DEFAULTS.fuelEffect - 0.2 : n === 2 ? 0.55 : 0.85;
    out[e.id] = Math.round((f1Lap(circuit, en, f1AiSetup(F1.team(e.teamId))) + prog + f1Gauss(r) * 0.22) * 1000) / 1000;
  });
  return out;
}
ACTIONS['fp-end'] = () => {
  const w = F1.live(); if (!w || w.status !== 'practice') return;
  const n = curSession(w), done = endedSessions(w).length; if (done >= sessionsOf(w)) { toast('Practice is over: run qualifying.', true); return; }
  run(async () => {
    const doc = clone(S.store.f1_weekends[w.id]);
    let rec = { n };
    if (fullPractice(w)) { rec = simulateSession(w, n); S._fpRec = Object.assign(rec, { wid: w.id }); }
    rec.times = sessionTimes(w, n, fullPractice(w) ? rec : null); rec.endedAt = nowIso(); delete S._fpRec; delete rec.wid;
    doc.practice = { session: Math.min(sessionsOf(w), n + 1), done: (done ? doc.practice.done : []).concat([rec]) };
    await Data.put('f1_weekends', w.id, doc);
    await Data.audit('f1.practice', `${sessionName(w, n)} ended`);
  }, n < sessionsOf(w) ? `${sessionName(w, n)} is over: timesheet and debriefs are out. ${sessionName(w, n + 1)} is open.` : 'Practice is over: timesheet and debriefs are out. Run qualifying when you’re ready.');
};
function timesheetHtml(w, s) {
  const rows = Object.keys(s.times).map(id => ({ id, t: s.times[id] })).sort((a, b) => (a.t || 999) - (b.t || 999)), best = rows[0] && rows[0].t;
  const ents = w.entrants || f1Entrants();
  return `${sessionReportHtml(w, s)}<table class="data compact timing"><thead><tr><th>P</th><th>Driver</th><th class="num">Best</th><th class="num">Gap</th></tr></thead><tbody>${rows.map((x, i) => { const e = ents.find(z => z.id === x.id) || {};
    return `<tr class="${e.charId ? 'me' : ''}"><td>${x.t ? i + 1 : ''}</td><td><span class="f1-bar" style="background:${esc(f1Colour(e.teamId))}"></span>${esc(e.name || x.id)}${e.charId ? ' <span class="tag player">Player</span>' : ''}</td>
      <td class="num">${x.t ? f1Fmt(x.t) : '<span class="muted">No time</span>'}</td><td class="num">${x.t && i ? '+' + (x.t - best).toFixed(3) : ''}</td></tr>`; }).join('')}</tbody></table>`;
}

/* ---------------------------------------------------------------- the set-up guide */
const fuzz = (v, r, sd) => clampN(Math.round((v + f1Gauss(r) * sd) / 5) * 5, 0, 100);
function setupGuideHtml(w, ent, ro) {
  const t = F1.track(w.trackId) || {}, base = TYPE_IDEAL[t.type] || TYPE_IDEAL.mixed, st = styleOf(ent), pref = STYLE_PREF[st] || STYLE_PREF.technical;
  const done = endedSessions(w).length, exp = (ent.v3 && ent.v3.experience) || 50, rap = f1Rapport(ent.teamId, ent.car);
  /* The engineer's error is fixed for the weekend and shrinks each session, so the guess closes in steadily. */
  const sd = Math.max(3, 14 - done * 3 - exp / 20 - rap * 1.5), r = RaceEngine.rng(h32(w.seed, ent.id, 'guide')), ideal = f1IdealFor(w, ent);
  const guess = { wing: fuzz(ideal.wing, r, sd), susp: fuzz(ideal.susp, r, sd), diff: fuzz(ideal.diff, r, sd) };
  const dir = (v, lo, hi) => v > 3 ? hi : v < -3 ? lo : 'about the same';
  return `<details class="guide"><summary><b>Set-up guide</b> <span class="muted small">engineer’s best guess: downforce ${guess.wing}, suspension ${guess.susp}, diff ${guess.diff}</span></summary>
    <p><b>${esc(t.name || '')}:</b> ${esc(TYPE_TEXT[t.type] || TYPE_TEXT.mixed)} <span class="muted small">Teams usually start around downforce ${base.wing}, suspension ${base.susp}.</span></p>
    <p><b>${esc(ent.name)} (${esc(styleName(st).toLowerCase())}):</b> likes ${esc(pref.likes)}. Can’t stand ${esc(pref.hates)}. Against a typical driver: downforce ${dir(pref.wing, 'lower', 'higher')}, suspension ${dir(pref.susp, 'softer', 'stiffer')}, diff ${dir(pref.diff, 'more open', 'more locked')}.</p>
    <p><b>Engineer’s best guess${done ? ` after ${sessionName(w, done)}` : ''}:</b> downforce ${guess.wing}, suspension ${guess.susp}, differential ${guess.diff}. <span class="muted small">Within about ±${Math.round(sd * 1.5 / 5) * 5 || 5} on each; it sharpens with every session${rap ? ', and rapport helps' : ''}.</span></p>
    </details>${ro ? '' : `<div class="guide-use"><button class="btn small" data-act="guide-use" data-car="${esc(ent.id)}" data-wing="${guess.wing}" data-susp="${guess.susp}" data-diff="${guess.diff}">Put the engineer’s guess on the dials</button></div>`}`;
}
ACTIONS['guide-use'] = d => { const f = (S.ui.form.f1d = S.ui.form.f1d || {}); f[d.car] = { wing: Number(d.wing), susp: Number(d.susp), diff: Number(d.diff) }; render(); };

/* ---------------------------------------------------------------- debriefs */
function sessionDebriefHtml(w, ent, s) {
  const n = s.n, runs = runsIn(w, ent.id, n), rows = Object.keys(s.times).filter(id => s.times[id]).sort((a, b) => s.times[a] - s.times[b]);
  const pos = rows.indexOf(ent.id) + 1, gap = pos > 1 ? s.times[ent.id] - s.times[rows[0]] : 0;
  const lost = runs.filter(r => (runContext(w, r) || {}).lost), crashed = (s.crashes || []).indexOf(ent.id) !== -1, failed = (s.failures || []).indexOf(ent.id) !== -1;
  const wxLine = s.weather ? ` ${weatherText(s.weather)}` : '';
  if (!runs.length) return `<li><b>${sessionName(w, n)}:</b>${esc(wxLine)} The car didn’t run. No set-up work, no time, and no confidence gained.</li>`;
  if (lost.length === runs.length) return `<li><b>${sessionName(w, n)}:</b>${esc(wxLine)} ${crashed ? 'The car crashed' : failed ? 'A mechanical problem stopped the car' : 'A red flag cost the running'}, and every planned run was lost. ${crashed ? 'Confidence took a knock.' : 'No confidence gained.'}</li>`;
  const b = bestSetupIn(w, ent, runs), ideal = f1IdealFor(w, ent), st = styleOf(ent), pref = STYLE_PREF[st] || STYLE_PREF.technical;
  const before = Math.round(confidenceAfter(w, ent, n - 1) * 100), after = Math.round(confidenceAfter(w, ent, n) * 100);
  const notes = [];
  if (s.weather && (s.weather.start !== 'dry' || s.weather.change)) notes.push(weatherText(s.weather) + ' Wet running tells you less about the dry set-up.');
  if (lost.length) notes.push(`${plural(lost.length, 'run')} lost: ${lost.map(r => runContext(w, r).lost.toLowerCase().replace(/\.$/, '')).join('; ')}.`);
  if (crashed) notes.push('The crash knocked the driver’s confidence and costs £0.4m in repairs.');
  if (b) {
    const r = RaceEngine.rng(h32(w.seed, ent.id, 'debrief', n)), noise = (2 + (100 - ((ent.v3 && ent.v3.experience) || 50)) / 12) * rapportNoise(f1Rapport(ent.teamId, ent.car));
    const errs = DIALS.map(([k, label], i) => ({ k, label, d: (Number(b.r.dials[k]) || 50) - ideal[k] + f1Gauss(r) * noise, wgt: [0.5, 0.4, 0.3][i] })).sort((x, y) => Math.abs(y.d) * y.wgt - Math.abs(x.d) * x.wgt);
    notes.push(b.q >= 88 ? `The set-up is very close to what ${ent.name.split(' ')[0]} wants.` : b.q >= 75 ? 'The set-up is getting there.' : 'The set-up is still some way off.');
    const top = errs[0];
    if (Math.abs(top.d) >= 5) notes.push(`Biggest gain: ${NOTES[top.k][top.d > 0 ? 0 : 1](top.d)}`);
    if (b.q < 80 && Math.abs(top.d) >= 5) notes.push(`${ent.name.split(' ')[0]} likes ${pref.likes.split(':')[0]}; this car isn’t there yet.`);
  } else notes.push('No set-up runs this session, so there’s nothing new on the set-up.');
  const did = k => f1Runs(w, ent.id).some(x => x.kind === k && (x.session || 1) <= n);
  if (n < sessionsOf(w)) { if (!did('long')) notes.push(`Next: a long run, to learn the tyres for the race plans.`); else if (!did('quali') && n === sessionsOf(w) - 1) notes.push('Next: a qualifying simulation in the last session.'); }
  return `<li><b>${sessionName(w, n)}:</b> ${pos ? `P${pos}${gap ? `, +${gap.toFixed(3)}` : ', fastest'}` : 'no representative time'}. Confidence ${before}% to <b>${after}%</b>.<ul>${notes.map(x => `<li>${esc(x)}</li>`).join('')}</ul></li>`;
}
function practiceDebriefsHtml(w, ent) {
  const done = endedSessions(w); if (!done.length) return '';
  const rev = done.slice().reverse();
  return `<div class="debriefs"><h4>Debrief</h4><ul class="runs">${sessionDebriefHtml(w, ent, rev[0])}</ul>${rev.length > 1 ? `<details><summary>Earlier debriefs</summary><ul class="runs">${rev.slice(1).map(s => sessionDebriefHtml(w, ent, s)).join('')}</ul></details>` : ''}
    <p class="muted small">Confidence at this circuit is worth up to ${CONF_MAX.toFixed(1)}s a lap in qualifying and the race. It builds with every session the car runs, more when the set-up suits the driver.</p></div>`;
}
/* After qualifying: where the time went, and what it means for the race. */
function qualiDebriefHtml(w, ent) {
  if (!w.quali || !w.quali.results) return '';
  const res = w.quali.results, best = r => { const t = (r.times || []).filter(Boolean); return t.length ? Math.min(...t) : null; };
  const me = res.find(r => r.id === ent.id); if (!me || !best(me)) return '';
  const all = res.map(r => ({ id: r.id, t: best(r) })).filter(x => x.t).sort((a, b) => a.t - b.t), pole = all[0].t, pos = (w.state && w.state.cars.find(c => c.id === ent.id) ? (w.quali.grid || []).indexOf(ent.id) + 1 : all.findIndex(x => x.id === ent.id) + 1);
  const q = (w.setup && w.setup[ent.id]) || f1AiSetup(F1.team(ent.teamId)), conf = (w.confidence && w.confidence[ent.id] != null) ? w.confidence[ent.id] : confidenceNow(w, ent);
  const setupLoss = (95 - q) * F1_RULES.setupCoef, confLoss = CONF_MAX * (1 - conf), mine = best(me), better = mine - setupLoss - confLoss;
  const could = all.filter(x => x.id !== ent.id && x.t < better).length + 1;
  const knowsTyres = f1Runs(w, ent.id).some(x => x.kind === 'long');
  const pen = w.penalties && w.penalties[ent.id];
  return `<div class="debriefs"><h4>Qualifying debrief</h4><ul class="runs"><li><b>P${pos}</b>${mine > pole ? `, ${(mine - pole).toFixed(3)}s off pole` : ', pole position'}.${pen ? ` Starts ${pen.places} places further back: ${esc(pen.reason)}.` : ''}<ul>
    <li>Set-up: ${({ locked: 'the dials chosen for qualifying', practice: 'the latest set-up run from practice', previous: 'the set-up carried over from last time' })[(w.setupSource || {})[ent.id]] || 'a standard set-up'}, quality ${q} of 95, costing about ${setupLoss.toFixed(2)}s a lap against a perfect one.</li>
    <li>Confidence: ${Math.round(conf * 100)}%, costing about ${confLoss.toFixed(2)}s a lap against full confidence.</li>
    ${setupLoss + confLoss > 0.05 && could < pos ? `<li>With both perfect, that lap was worth about P${could}.</li>` : ''}
    <li>For the race: the set-up stays as it is. ${knowsTyres ? 'Your long runs have measured the tyres: check the race plans against them.' : 'Nobody measured the tyres in practice, so the race plans work from rough tyre life: leave some margin.'}</li></ul></li></ul></div>`;
}

/* =====================================================================
   F1 SIM — full practice sessions.
   In a full race weekend, practice runs like qualifying: teams plan
   their runs for the coming session, then Race Control runs it. Each
   session has its own weather, drawn from the weekend's forecast (dry,
   damp or wet, and rain can arrive or clear halfway through), and its
   own chaos: red flags that cut runs short, crashes (likelier in the wet,
   for inexperienced drivers and on qualifying simulations) and
   mechanical failures (from the team's reliability). Race Control's
   safety-car and failure settings scale them. Nobody sees a run's
   result until its session has run.
   Quick practice (results straight away, always dry) stays available
   for any weekend, and the Test Track keeps its fixed conditions.
   ===================================================================== */
'use strict';

const WET_PEN = { dry: 0, damp: 4.5, wet: 9 };
const PRACTICE_REPAIR = 0.4;   // £m for a practice crash
const fullPractice = w => !!w && !w.test && raceSettings(w).practice === 'full';
const condName = c => c === 'wet' ? 'wet' : c === 'damp' ? 'damp' : 'dry';

/* Chance of rain in a session, from the weekend's weather and Race Control's rain setting. */
function sessionRainChance(w) {
  const s = raceSettings(w), t = F1.track(w.trackId) || {};
  if (w.weatherMode === 'dry') return 0; if (w.weatherMode === 'wet') return 0.75; if (w.weatherMode === 'mid') return 0.5;
  return s.rainPct !== 'track' && s.rainPct != null ? Number(s.rainPct) / 100 : (t.wr || 0) * 0.6 / 100;
}
function sessionWeather(w, n) {
  const r = RaceEngine.rng(h32(w.seed, 'fpwx', n)), p = sessionRainChance(w);
  if (r() >= p) return { start: 'dry', change: null };
  const heavy = r() < 0.4 ? 'wet' : 'damp';
  if (r() < 0.5) return { start: heavy, change: r() < 0.4 ? { at: 0.5, to: 'dry' } : null };
  return { start: 'dry', change: { at: 0.5, to: heavy } };
}
const condAt = (wx, frac) => wx.change && frac >= wx.change.at ? wx.change.to : wx.start;
function weatherText(wx) {
  if (!wx.change) return wx.start === 'dry' ? 'Dry throughout.' : `${condName(wx.start).replace(/^./, c => c.toUpperCase())} throughout.`;
  return wx.change.to === 'dry' ? `Started ${condName(wx.start)}, dried out halfway through.` : `Started dry; rain arrived halfway through and the track went ${condName(wx.change.to)}.`;
}

/* Run the session: who loses which runs, and why. */
function simulateSession(w, n) {
  const st = raceSettings(w), wx = sessionWeather(w, n), r = RaceEngine.rng(h32(w.seed, 'fpsim', n)), per = runsPerSession(w);
  const rec = { n, weather: wx, events: [], lost: {}, cond: {}, crashes: [], failures: [], redFlag: null };
  const wetty = wx.start !== 'dry' || !!wx.change;
  const redAt = r() < 0.22 * st.scRate * (wetty ? 1.6 : 1) ? (r() < 0.5 ? 0 : 1) : null;
  f1Entrants().forEach(e => {
    const runs = playerRun(w, e) ? runsIn(w, e.id, n) : null, slots = runs ? runs.length : per, team = F1.team(e.teamId);
    const exp = (e.v3 && e.v3.experience) || 50; let out = null;
    for (let i = 0; i < slots; i++) {
      const id = runs ? runs[i].id : null, cond = condAt(wx, (i + 0.5) / per);
      if (id) rec.cond[id] = cond;
      if (out) { if (id) rec.lost[id] = out; continue; }
      if (r() < 0.003 * st.failRate * (1 + (95 - (team.reliability || 90)) / 10)) {
        out = 'A mechanical problem ended the session early.'; rec.failures.push(e.id); rec.events.push({ slot: i, ids: [e.id], text: `${e.name} stops on track with a mechanical problem.` }); if (id) rec.lost[id] = out; continue; }
      const quali = runs && runs[i].kind === 'quali';
      if (r() < 0.006 * st.scRate * (cond === 'wet' ? 3 : cond === 'damp' ? 2 : 1) * (1 + (60 - exp) / 100) * (quali ? 1.5 : 1)) {
        out = 'Crashed. The car couldn’t be repaired in time.'; rec.crashes.push(e.id); rec.events.push({ slot: i, ids: [e.id], text: `${e.name} crashes${cond !== 'dry' ? ' in the ' + condName(cond) : ''}. Red flag.` }); if (id) rec.lost[id] = 'Crashed. The car needed repairs.'; continue; }
      if (redAt === i && r() < 0.4 && id) rec.lost[id] = 'Cut short by a red flag.';
    }
  });
  if (redAt != null) { rec.redFlag = redAt; rec.events.push({ slot: redAt, ids: [], text: 'Red flag: debris on the track. Some teams lose their run.' }); }
  if (wx.change) rec.events.push({ slot: wx.change.at * per, ids: [], text: wx.change.to === 'dry' ? 'The track starts to dry.' : 'Rain arrives.' });
  rec.events.sort((a, b) => a.slot - b.slot);
  return rec;
}
/* A run's context: not run yet, lost, or the conditions it ran in. */
function runContext(w, run) {
  if (!fullPractice(w)) return null;
  const rec = (S._fpRec && S._fpRec.n === (run.session || 1) && S._fpRec.wid === w.id) ? S._fpRec : endedSessions(w).find(s => s.n === (run.session || 1));
  if (!rec || !rec.weather) return { pending: true };
  if (rec.lost && rec.lost[run.id]) return { lost: rec.lost[run.id] };
  return { cond: (rec.cond && rec.cond[run.id]) || 'dry' };
}
/* Lap times for cars nobody plays: their programme in the session's conditions, minus what they lost. */
function aiSessionLap(w, n, e, entry, rec) {
  if (!rec.weather) return null;
  const per = runsPerSession(w), circuit = FormulaRacingAdapter.toCircuit(F1.track(w.trackId)), r = RaceEngine.rng(h32(w.seed, 'fp', n, e.id));
  const failed = rec.failures.indexOf(e.id) !== -1 || rec.crashes.indexOf(e.id) !== -1, last = n === sessionsOf(w);
  let best = null;
  for (let i = 0; i < per; i++) {
    if (failed && i > 0) break;
    const cond = condAt(rec.weather, (i + 0.5) / per), prog = last && i === per - 1 ? -RaceEngine.DEFAULTS.fuelEffect - 0.2 : (n === 2 ? 0.55 : 0.85);
    const t = f1Lap(circuit, entry, f1AiSetup(F1.team(e.teamId))) + prog + WET_PEN[cond] + f1Gauss(r) * 0.22;
    best = best == null ? t : Math.min(best, t);
  }
  return best;
}
ACTIONS['run-cancel'] = d => {
  const r = get('f1_runs', d.id), w = F1.live(); if (!r || !w) return;
  if (!(runContext(w, r) || {}).pending) { toast('That run has already happened.', true); return; }
  run(async () => { await Data.remove('f1_runs', r.id); }, 'Run taken off the plan.');
};
function sessionReportHtml(w, s) {
  if (!s.weather) return '';
  return `<p><b>Conditions:</b> ${esc(weatherText(s.weather))}</p>${s.events.length ? `<ul class="fp-events">${s.events.map(e => `<li>${esc(e.text)}</li>`).join('')}</ul>` : '<p class="muted small">A clean session.</p>'}`;
}
function practiceForecastText(w) {
  const p = Math.round(sessionRainChance(w) * 100);
  return p ? `${p}% chance of rain in each session.` : 'Dry sessions expected.';
}

/* =====================================================================
   F1 SIM — the Race Weekend page, streamlined, and sensible defaults.
   Nobody has to lock anything in. A car's qualifying set-up is, in order:
   the dials someone chose for qualifying, the latest set-up run this
   weekend, the set-up it raced last time (scored against what this
   circuit and driver need), or a standard set-up. Its race plans are the
   plans saved this weekend, the plans from its last race (rescaled to
   this race's length), or the team's own preset.
   The page leads with what's happening and what each of your cars will
   use, then tabs: Set-up (or the qualifying debrief), Race plan, Timing
   and Entry list. A team principal switches between their two cars.
   ===================================================================== */
'use strict';

/* ---------------------------------------------------------------- defaults: set-up */
function lastSetupRun(w, carId) {
  return f1Runs(w, carId).filter(r => r.kind === 'setup' && r.dials).filter(r => { const x = runContext(w, r); return !x || x.cond; }).pop() || null;
}
/* The same car (team and car number) at earlier weekends of this series, newest first. */
function earlierSameCar(w, ent) {
  return list('f1_weekends').filter(x => x.id !== w.id && wSeries(x) === wSeries(w) && String(x.createdAt) < String(w.createdAt) && x.entrants)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .map(x => ({ w: x, e: x.entrants.find(z => z.teamId === ent.teamId && z.car === ent.car) })).filter(x => x.e);
}
function setupChoice(w, ent) {
  const call = f1Calls(w).filter(c => c.type === 'setup' && c.carId === ent.id && c.value && typeof c.value === 'object' && f1CallAllowed(c, w)).pop();
  if (call) return { dials: call.value, source: 'locked', by: call.charId, text: `Chosen for qualifying: ${dialText(call.value)}.` };
  const run = lastSetupRun(w, ent.id);
  if (run) return { dials: run.dials, source: 'practice', by: run.charId, text: `Your latest set-up run: ${dialText(run.dials)}.` };
  for (const x of earlierSameCar(w, ent)) {
    const d = (x.w.setupDials || {})[x.e.id] || (lastSetupRun(x.w, x.e.id) || {}).dials;
    if (d) return { dials: d, source: 'previous', by: null, text: `The set-up from ${(get('f1_tracks', x.w.trackId) || {}).name || 'last time'}: ${dialText(d)}. It may not suit this circuit.` };
  }
  return null;
}
function setupChoiceText(w, ent) { const c = setupChoice(w, ent); return c ? c.text : 'A standard set-up: nobody has run this car yet.'; }

/* ---------------------------------------------------------------- defaults: race plans */
function prevPlanDoc(w, ent) {
  const N = raceLaps(w);
  for (const x of earlierSameCar(w, ent)) {
    const doc = f1Plan(x.w, x.e); if (!doc) continue;
    const oldN = x.w.state ? x.w.state.laps : raceLaps(x.w), k = N / Math.max(1, oldN), sc = v => v ? Math.max(2, Math.min(N - 1, Math.round(v * k))) : v;
    return { plans: doc.plans.map(p => Object.assign({}, clone(p), { stops: (p.stops || []).map(s => ({ lap: sc(s.lap), compound: s.compound })) })),
      active: doc.active || 0, triggers: (doc.triggers || []).map(t => Object.assign({}, t, { from: sc(t.from), to: sc(t.to) })), approach: doc.approach, preset: doc.preset,
      isPrevious: true, from: (get('f1_tracks', x.w.trackId) || {}).name || 'the last race' };
  }
  return null;
}
const planDocFor = (w, ent) => f1Plan(w, ent) || (teamHasPlayers(ent.teamId) ? (prevPlanDoc(w, ent) || defaultPlanDoc(w, ent)) : null);
function planSourceText(w, ent) {
  const doc = f1Plan(w, ent); if (doc) { const by = get('characters', doc.charId); return `Saved by ${by ? by.name : 'the team'}: ${PLAN_NAMES[doc.active || 0]} to start, ${approachLabel(doc.approach).toLowerCase()} approach.`; }
  const p = prevPlanDoc(w, ent); if (p) return `Not saved this weekend, so the plans from ${p.from} carry over, resized to this race.`;
  return `Not saved, so the team’s own preset and ${ent.name.split(' ')[0]}’s natural approach.`;
}

/* ---------------------------------------------------------------- the page */
function myWeekendCars(w) {
  if (!S.charId) return [];
  const seats = f1MySeats(); if (!seats.length) return [];
  return (w.entrants || f1Entrants()).filter(e => seats.some(s => s.teamId === e.teamId && (s.role === 'principal' || s.car === e.car)));
}
ACTIONS['wk-car'] = d => { S.ui.wkCar = d.id; render(); };
ACTIONS['wk-tab'] = d => { S.ui.wkTab = d.tab; S.ui.wkTabFor = d.status; render(); };
function stageLine(w) {
  const st = w.state;
  if (w.status === 'practice') { const done = endedSessions(w).length, all = done >= sessionsOf(w);
    return all ? 'Practice is over. Qualifying is next.' : fullPractice(w) ? `${sessionName(w, curSession(w))} is next. Plan up to ${runsPerSession(w)} runs per car before Race Control runs it.` : `${sessionName(w, curSession(w))}: up to ${runsPerSession(w)} runs per car, with results straight away.`; }
  if (w.status === 'quali') return `Qualifying: Q${w.qualiStage || 1} is done.`;
  if (st && st.lap === 0) return 'The grid is set. The race is next.';
  if (st && !st.finished) return `Race: lap ${st.lap} of ${st.laps}.${raceLocked(w) ? ' Plans and triggers are running the cars.' : ''}`;
  return 'Finished.';
}
function nowCardHtml(w, cars) {
  if (!cars.length || w.status === 'finished') return `<section class="card now-card"><p class="now-stage">${esc(stageLine(w))}</p></section>`;
  const before = w.status === 'practice', rows = cars.map(e => {
    const t = F1.team(e.teamId), ent = Object.assign({}, e, { v3: (f1Entrants().find(x => x.id === e.id) || {}).v3 }), car = w.state && w.state.cars.find(c => c.id === e.id);
    const conf = Math.round(confidenceNow(w, ent) * 100), left = before && endedSessions(w).length < sessionsOf(w) ? runsPerSession(w) - runsIn(w, e.id, curSession(w)).length : null;
    return `<tr style="--team:${esc(t.color)}"><td><span class="f1-bar" style="background:${esc(t.color)}"></span><b>${esc(e.name)}</b></td>
      ${before ? `<td>${left != null ? `${plural(left, 'run')} left in ${esc(sessionName(w, curSession(w)))}` : 'Practice done'}<br><span class="muted small">Confidence ${conf}%</span></td>
        <td><span class="muted small">Qualifying set-up</span><br>${esc(setupChoiceText(w, ent))}</td>` : car ? `<td>${car.status === 'running' ? `P${f1Order(w.state).indexOf(car) + 1}` : 'Out'}</td><td><span class="muted small">Grid</span><br>P${(w.quali && w.quali.grid ? w.quali.grid.indexOf(e.id) + 1 : '–')}</td>` : '<td></td><td></td>'}
      <td><span class="muted small">Race plans</span><br>${esc(w.state && w.state.lap > 0 && car ? `${car.planName || 'AI strategist'}, ${approachLabel(car.approach).toLowerCase()}` : planSourceText(w, ent))}</td></tr>`;
  }).join('');
  return `<section class="card now-card"><p class="now-stage">${esc(stageLine(w))}</p><div class="scroll-x"><table class="data compact now-table"><tbody>${rows}</tbody></table></div>
    <p class="muted small">Nothing has to be locked in. Anything you don’t set uses the latest set-up run, then the last race’s set-up and plans, then the team’s defaults.</p></section>`;
}
function carPickerHtml(cars) {
  if (cars.length < 2) return '';
  const cur = S.ui.wkCar && cars.some(e => e.id === S.ui.wkCar) ? S.ui.wkCar : cars[0].id;
  return `<div class="car-pick" role="tablist" aria-label="Car">${cars.map(e => `<button role="tab" class="pill" data-act="wk-car" data-id="${esc(e.id)}" aria-selected="${e.id === cur}" style="--team:${esc(F1.team(e.teamId).color)}">${esc(e.name)}</button>`).join('')}</div>`;
}
function timingHtml(w) {
  const st = w.state, done = endedSessions(w);
  if (!st) {
    if (!done.length) return '<section class="card"><p class="muted">No session has run yet. Timesheets appear here after each practice session.</p></section>';
    const last = done[done.length - 1];
    return `<section class="card"><h2>${esc(sessionName(w, last.n))} timesheet</h2><div class="scroll-x">${timesheetHtml(w, last)}</div>${done.length > 1 ? `<details><summary>Earlier sessions</summary>${done.slice(0, -1).reverse().map(s => `<h4>${esc(sessionName(w, s.n))}</h4><div class="scroll-x">${timesheetHtml(w, s)}</div>`).join('')}</details>` : ''}</section>`;
  }
  const racing = st.lap > 0, tab = S.ui.f1tab && (racing || S.ui.f1tab === 'feed') ? S.ui.f1tab : 'feed';
  const tabs = [['feed', 'Race log'], ['lapchart', 'Lap chart'], ['tyres', 'Tyre strategy'], ['driver', S.ui.f1pick ? `Driver: ${S.ui.f1pick}` : 'Driver']].filter(x => racing || x[0] === 'feed');
  const body = tab === 'lapchart' ? lvLapChartHtml(w) : tab === 'tyres' ? f1ChartHtml(w) : tab === 'driver' ? lvDriverHtml(w) : lvFeedHtml(w);
  return `<div class="f1-main"><section class="card"><h2>${racing ? 'Timing' : w.status === 'quali' ? `Qualifying: Q${w.qualiStage || 1}` : 'Qualifying'}</h2><div class="scroll-x">${lvTowerHtml(w)}</div></section>
    <section class="card"><div class="tabs" role="tablist">${tabs.map(([k, l]) => `<button role="tab" class="tab" data-act="f1-tab" data-tab="${k}" aria-selected="${tab === k}">${esc(l)}</button>`).join('')}</div>${body}</section></div>`;
}
function entryListHtml(w) {
  const ents = w.entrants || f1Entrants();
  return `<section class="card"><h2>Entry list</h2><div class="scroll-x"><table class="data"><thead><tr><th>Car</th><th>Driver</th><th>Team</th></tr></thead><tbody>${ents.map(e => `<tr><td><b>${esc(e.id)}</b></td><td>${careerLink(e.personId, e.name)}${e.charId ? ' <span class="tag player">Player</span>' : ''}</td><td><span class="f1-bar" style="background:${esc(f1Colour(e.teamId))}"></span>${esc(F1.team(e.teamId).name)}</td></tr>`).join('')}</tbody></table></div>
    ${w.entrants ? '' : '<p class="muted small">The entry list is fixed when qualifying runs; seat changes after that apply from the next weekend.</p>'}</section>`;
}

const _weekendView = ROUTES.weekend.view;
ROUTES.weekend.view = function () {
  const view = S.ui.f1view ? get('f1_weekends', S.ui.f1view) : null, w = view || F1.live();
  if (!w || w.status === 'finished' || view || !F1.teams().length) return _weekendView();
  const t = F1.track(w.trackId) || { name: w.trackId, laps: 0 }, st = w.state, sprint = w.session === 'sprint', laps = st ? st.laps : raceLaps(w);
  const lapLbl = w.status === 'practice' ? (endedSessions(w).length >= sessionsOf(w) ? 'Done' : sessionName(w, curSession(w))) : w.status === 'quali' ? 'Qualifying' : st.lap === 0 ? 'Grid set' : (w.live ? 'Live, lap' : 'Lap');
  const right = `<div class="f1-lap ${w.live ? 'live' : ''}" aria-live="polite"><small>${w.status === 'practice' ? 'Practice' : lapLbl}</small>${st && w.status !== 'quali' ? `${st.lap}<span class="of">/${laps}</span>` : w.status === 'quali' ? `Q${w.qualiStage || 1}` : esc(lapLbl)}</div>`;
  const track = st ? st.track[Math.max(0, st.lap - 1)] : 0;
  const chips = st && st.lap ? `<p class="chips"><span class="tag ${track === 2 ? 'wet' : track === 1 ? 'damp' : ''}">${['Dry', 'Damp', 'Wet'][track]} track</span>${st.sc.type ? ` <span class="tag flag">${st.sc.type === 'sc' ? 'Safety car' : 'Virtual safety car'}</span>` : ''}</p>` : '';
  let h = `<div class="page-head"><div><p class="eyebrow">${w.session === 'test' ? 'Pre-season testing' : `Round ${esc(t.round || '')}${sprint ? ', sprint' : ''}`}</p><h1>${esc(t.flag || '')} ${esc(t.name)}${sprint ? ' Sprint' : w.session === 'test' ? ' testing' : ''}</h1><p>${esc(t.circuit || '')}, ${laps} laps. ${esc(forecastText(w))}</p>${chips}</div>${right}</div>`;
  h += lvStagesHtml(w);
  if (S.isGm) h += lvControlHtml(w) || '';
  const cars = myWeekendCars(w);
  h += f1MomentCardHtml(w) + nowCardHtml(w, cars);
  const before = w.status === 'practice', racing = st && st.lap > 0;
  const tabs = cars.length ? (before ? [['setup', 'Set-up'], ['plan', 'Race plan'], ['timing', 'Timing'], ['entry', 'Entry list']]
    : racing ? (raceLocked(w) ? [['timing', 'Timing'], ['wall', 'Your cars'], ['plan', 'Race plan']] : [['wall', 'Pit wall'], ['timing', 'Timing'], ['plan', 'Race plan']])
    : [['debrief', 'Qualifying debrief'], ['plan', 'Race plan'], ['timing', 'Timing'], ['entry', 'Entry list']])
    : [['timing', 'Timing'], ['entry', 'Entry list']];
  const tab = S.ui.wkTab && S.ui.wkTabFor === w.status + (racing ? 'r' : '') && tabs.some(x => x[0] === S.ui.wkTab) ? S.ui.wkTab : tabs[0][0];
  h += `<div class="tabs wk-tabs" role="tablist">${tabs.map(([k, l]) => `<button role="tab" class="tab" data-act="wk-tab" data-tab="${k}" data-status="${esc(w.status + (racing ? 'r' : ''))}" aria-selected="${tab === k}">${esc(l)}</button>`).join('')}</div>`;
  const picker = ['setup', 'plan', 'wall', 'debrief'].indexOf(tab) !== -1 ? carPickerHtml(cars) : '';
  S.ui.wkCarNow = cars.length > 1 ? (S.ui.wkCar && cars.some(e => e.id === S.ui.wkCar) ? S.ui.wkCar : cars[0].id) : null;
  if (tab === 'setup' || tab === 'wall') h += picker + (f1PitWallHtml(w) || '<section class="card"><p class="muted">Nothing to do on this car right now.</p></section>');
  else if (tab === 'debrief') h += picker + cars.filter(e => !S.ui.wkCarNow || e.id === S.ui.wkCarNow).map(e => `<section class="card" style="--team:${esc(F1.team(e.teamId).color)}"><h2>${esc(e.name)}</h2>${qualiDebriefHtml(w, Object.assign({}, e, { v3: (f1Entrants().find(x => x.id === e.id) || {}).v3 })) || '<p class="muted">The debrief comes when qualifying is over.</p>'}</section>`).join('');
  else if (tab === 'plan') h += picker + (f1StrategyCardHtml(w) || '<section class="card"><p class="muted">Only the team principal, the car’s race engineer and its driver plan its race.</p></section>');
  else if (tab === 'timing') h += timingHtml(w);
  else h += entryListHtml(w);
  return h;
};

/* =====================================================================
   F1 SIM — the Race Weekend page, pit-wall layout.
   Three columns, nothing hidden behind tabs: on the left the weekend's
   sessions and what your car will use if you do nothing; in the middle
   the work (set-up, race plan, timing or the entry list, picked from the
   left); on the right the latest debrief and timing, or during the race
   your car and the race log. The big numbers along the top change with
   the stage. People without a seat keep the simpler tabbed page.
   ===================================================================== */
'use strict';

const _weekendTabs = ROUTES.weekend.view;
const pctRain = w => Math.round(sessionRainChance(w) * 100);
const gridPos = (w, id) => (w.quali && w.quali.grid ? w.quali.grid.indexOf(id) + 1 : 0);
function entWithV3(e) { return Object.assign({}, e, { v3: (f1Entrants().find(x => x.id === e.id) || {}).v3 }); }

/* The weekend's sessions, with what each meant (or will mean) for this car. */
function railSessionsHtml(w, ent) {
  const st = w.state, rows = [], done = endedSessions(w), cur = w.status === 'practice' && done.length < sessionsOf(w) ? curSession(w) : 0;
  for (let n = 1; n <= sessionsOf(w); n++) {
    const s = done.find(x => x.n === n), times = s && s.times ? Object.keys(s.times).filter(k => s.times[k]).sort((a, b) => s.times[a] - s.times[b]) : [];
    const pos = ent && times.indexOf(ent.id) + 1;
    rows.push({ label: sessionName(w, n), status: s ? (pos ? `Done, P${pos}` : 'Done') : n === cur ? (fullPractice(w) ? 'Plan now' : 'Running') : w.status === 'practice' ? `${runsPerSession(w)} runs` : 'Skipped', now: n === cur });
  }
  const single = seriesDoc(wSeries(w)).quali === 'single', g = ent ? gridPos(w, ent.id) : 0;
  if (w.session === 'test') return `<ol class="rail-sessions">${rows.map(r => `<li class="${r.now ? 'now' : ''}"><span>${esc(r.label)}</span><span>${esc(r.status)}</span></li>`).join('')}</ol>`;
  rows.push({ label: single ? 'Qualifying' : 'Qualifying', status: w.status === 'practice' ? (single ? 'One session' : 'Q1 to Q3') : w.status === 'quali' ? `Q${w.qualiStage || 1} done` : g ? `Grid P${g}` : 'Done', now: w.status === 'quali' });
  const car = ent && st ? st.cars.find(c => c.id === ent.id) : null, pos = car ? f1Order(st).indexOf(car) + 1 : 0;
  rows.push({ label: 'Race', status: !st || st.lap === 0 ? (raceSettings(w).lock !== false ? 'Official' : 'Live calls') : st.finished ? (car && car.status === 'running' ? `P${pos}` : 'Done') : `Lap ${st.lap}, P${pos || '–'}`, now: !!(st && st.lap > 0) || (w.status === 'grid') });
  return `<ol class="rail-sessions">${rows.map(r => `<li class="${r.now ? 'now' : ''}"><span>${esc(r.label)}</span><span>${esc(r.status)}</span></li>`).join('')}</ol>`;
}
/* The big numbers along the top, for the stage and the car. */
function statStripHtml(w, ent) {
  const st = w.state, cells = [];
  if (w.status === 'practice') {
    const all = endedSessions(w).length >= sessionsOf(w);
    cells.push(['Next', all ? (w.session === 'test' ? 'Done' : seriesDoc(wSeries(w)).quali === 'single' ? 'Quali' : 'Q1') : sessionName(w, curSession(w)), true], ['Rain chance', `${pctRain(w)}%`]);
    if (ent) cells.push(['Runs to plan', all ? '0' : String(runsPerSession(w) - runsIn(w, ent.id, curSession(w)).length)], ['Confidence', `${Math.round(confidenceNow(w, ent) * 100)}%`]);
  } else if (!st || st.lap === 0) {
    cells.push(['Stage', w.status === 'quali' ? `Q${w.qualiStage || 1}` : 'Grid set', true]);
    if (ent) cells.push(['Grid', gridPos(w, ent.id) ? `P${gridPos(w, ent.id)}` : '–'], ['Confidence', `${Math.round(((w.confidence || {})[ent.id] != null ? w.confidence[ent.id] : confidenceNow(w, ent)) * 100)}%`]);
    cells.push(['Laps', String(st ? st.laps : raceLaps(w))]);
  } else {
    const car = ent ? st.cars.find(c => c.id === ent.id) : null;
    cells.push(['Lap', `${st.lap}/${st.laps}`, true]);
    if (car) { const pos = f1Order(st).indexOf(car) + 1;
      cells.push(['Position', car.status === 'running' ? `P${pos}` : 'Out'], ['Tyre', car.status === 'running' ? `${RaceEngine.COMPOUNDS[car.tyre.compound].label} ${car.tyre.age}` : '–'], ['Plan', car.planName ? car.planName.replace('Plan ', '') : 'AI']); }
  }
  return `<div class="stat-strip">${cells.map(([k, v, hi]) => `<div><span>${esc(k)}</span><b class="${hi ? 'hi' : ''}">${esc(v)}</b></div>`).join('')}</div>`;
}
/* A short timesheet: the top eight, plus your cars if they're further down. */
function shortTimesheetHtml(w, s, mine) {
  const ents = w.entrants || f1Entrants(), rows = Object.keys(s.times).filter(k => s.times[k]).sort((a, b) => s.times[a] - s.times[b]), best = s.times[rows[0]];
  const show = rows.filter((id, i) => i < 8 || mine.indexOf(id) !== -1);
  return `<table class="data compact short-times"><tbody>${show.map(id => { const i = rows.indexOf(id), e = ents.find(z => z.id === id) || {};
    return `<tr class="${mine.indexOf(id) !== -1 ? 'me' : ''}"><td>${i + 1}</td><td><span class="f1-bar" style="background:${esc(f1Colour(e.teamId))}"></span>${esc(e.name || id)}</td><td class="num">${i ? '+' + (s.times[id] - best).toFixed(3) : f1Fmt(best)}</td></tr>`; }).join('')}</tbody></table>`;
}
function shortQualiHtml(w, mine) {
  const g = (w.quali && w.quali.grid) || [], ents = w.entrants || [], show = g.filter((id, i) => i < 10 || mine.indexOf(id) !== -1);
  return `<table class="data compact short-times"><tbody>${show.map(id => { const e = ents.find(z => z.id === id) || {};
    return `<tr class="${mine.indexOf(id) !== -1 ? 'me' : ''}"><td>${g.indexOf(id) + 1}</td><td><span class="f1-bar" style="background:${esc(f1Colour(e.teamId))}"></span>${esc(e.name || id)}</td></tr>`; }).join('')}</tbody></table>`;
}
ACTIONS['wk-view'] = d => { S.ui.wkView = d.view; S.ui.wkViewFor = d.stage; render(); };

ROUTES.weekend.view = function () {
  S.ui.wkRail = false;
  const view = S.ui.f1view ? get('f1_weekends', S.ui.f1view) : null, w = view || F1.live();
  if (!w || w.status === 'finished' || view || !F1.teams().length) return _weekendTabs();
  const cars = myWeekendCars(w); if (!cars.length) return _weekendTabs();
  S.ui.wkRail = true;
  const sel = cars.find(e => e.id === S.ui.wkCar) || cars[0], ent = entWithV3(sel), team = F1.team(sel.teamId), brand = typeof teamBrand === 'function' ? teamBrand(sel.teamId) : {};
  S.ui.wkCarNow = sel.id;
  const t = F1.track(w.trackId) || { name: w.trackId, laps: 0 }, st = w.state, sprint = w.session === 'sprint', racing = !!(st && st.lap > 0);
  const stage = w.status === 'practice' ? 'practice' : racing ? 'race' : 'quali';
  const views = (stage === 'practice' ? [['setup', 'Set-up'], ['plan', 'Race plan'], ['timing', 'Full timing'], ['entry', 'Entry list']]
    : stage === 'quali' ? [['timing', 'Qualifying'], ['plan', 'Race plan'], ['entry', 'Entry list']]
    : [['timing', 'Timing'], ['plan', 'Race plan'], ['entry', 'Entry list']]).filter(x => x[0] !== 'plan' || typeof involveAllows !== 'function' || involveAllows(S.charId, 'strategy'));
  const v = S.ui.wkView && S.ui.wkViewFor === stage && views.some(x => x[0] === S.ui.wkView) ? S.ui.wkView : views[0][0];
  const mine = cars.map(e => e.id);

  let h = `<div class="wk-head" style="--team:${esc(team.color)}"><div class="wk-title"><p class="muted">${w.session === 'test' ? `Pre-season testing, ${esc(t.circuit || t.name)}` : `Round ${esc(t.round || '')}, ${esc(t.circuit || t.name)}, ${st ? st.laps : raceLaps(w)} laps${sprint ? ', sprint' : ''}`}</p>
    <h1>${esc(t.flag || '')} ${esc(t.name)}${sprint ? ' Sprint' : w.session === 'test' ? ' testing' : ''}</h1>${exportButtonHtml(w) ? `<div class="wk-actions">${exportButtonHtml(w)}</div>` : ''}${racing ? `<p class="chips"><span class="tag ${st.track[Math.max(0, st.lap - 1)] === 2 ? 'wet' : st.track[Math.max(0, st.lap - 1)] === 1 ? 'damp' : ''}">${['Dry', 'Damp', 'Wet'][st.track[Math.max(0, st.lap - 1)]]} track</span>${st.sc.type ? ` <span class="tag flag">${st.sc.type === 'sc' ? 'Safety car' : 'Virtual safety car'}</span>` : ''}</p>` : ''}</div>
    ${statStripHtml(w, ent)}</div>`;
  if (S.isGm) h += lvControlHtml(w) || '';

  /* Left: the car, the weekend, the defaults, and what to work on. */
  const left = `<aside class="wk-rail" aria-label="Your weekend">
    ${cars.length > 1 ? `<div class="car-pick" role="tablist" aria-label="Car">${cars.map(e => `<button role="tab" class="pill" data-act="wk-car" data-id="${esc(e.id)}" aria-selected="${e.id === sel.id}" style="--team:${esc(F1.team(e.teamId).color)}">${esc(e.name)}</button>`).join('')}</div>` : ''}
    <div class="rail-car">${brand.logo ? `<img src="${esc(brand.logo)}" alt="${esc(team.name)}" class="team-logo">` : ''}<div><b>${esc(sel.name)}</b><span class="muted small">${esc(team.name)}, car ${esc(sel.car)}</span></div></div>
    <h2>Weekend</h2>${railSessionsHtml(w, ent)}
    <h2>Work on</h2><nav class="rail-views" aria-label="Work on">${views.map(([k, l]) => `<button class="${v === k ? 'on' : ''}" aria-current="${v === k ? 'page' : 'false'}" data-act="wk-view" data-view="${k}" data-stage="${stage}">${esc(l)}</button>`).join('')}</nav>
    ${!racing ? `<h2>If you do nothing</h2><dl class="rail-defaults">${stage === 'practice' ? `<div><dt>Qualifying set-up</dt><dd>${esc(setupChoiceText(w, ent))}</dd></div>` : ''}<div><dt>Race plans</dt><dd>${esc(planSourceText(w, ent))}</dd></div></dl>` : ''}
  </aside>`;

  /* Middle: the work. */
  let mid = racing ? f1MomentCardHtml(w) : '';
  if (v === 'setup') mid += f1PitWallHtml(w) || '<section class="card"><p class="muted">Nothing to do on this car right now.</p></section>';
  else if (v === 'plan') mid += f1StrategyCardHtml(w) || '<section class="card"><p class="muted">Only the team principal, the car’s race engineer and its driver plan its race.</p></section>';
  else if (v === 'entry') mid += entryListHtml(w);
  else if (stage === 'race') {
    /* The race: the tower, then the lap chart, tyres or your driver beneath it. The race log is on the right. */
    if (!S.ui.f1pick) S.ui.f1pick = sel.id;
    const tab = ['lapchart', 'tyres', 'driver'].indexOf(S.ui.f1tab) !== -1 ? S.ui.f1tab : 'driver';
    const body = tab === 'lapchart' ? lvLapChartHtml(w) : tab === 'tyres' ? f1ChartHtml(w) : lvDriverHtml(w);
    mid += `<section class="card"><h2>Timing</h2><div class="scroll-x">${lvTowerHtml(w)}</div></section>
      <section class="card"><div class="tabs" role="tablist">${[['driver', `Driver: ${S.ui.f1pick}`], ['lapchart', 'Lap chart'], ['tyres', 'Tyre strategy']].map(([k, l]) => `<button role="tab" class="tab" data-act="f1-tab" data-tab="${k}" aria-selected="${tab === k}">${esc(l)}</button>`).join('')}</div>${body}</section>`;
  } else mid += timingHtml(w);

  /* Right: what the last session said, and the timing; in the race, your car and the race log. */
  let right = '';
  if (stage === 'practice') {
    const done = endedSessions(w), last = done[done.length - 1];
    right += last ? `<section class="card"><h2>${esc(sessionName(w, last.n))} debrief</h2>${last.weather ? `<p class="muted small">${esc(weatherText(last.weather))}</p>` : ''}<ul class="runs">${sessionDebriefHtml(w, ent, last)}</ul>
        ${done.length > 1 ? `<details><summary>Earlier debriefs</summary><ul class="runs">${done.slice(0, -1).reverse().map(s => sessionDebriefHtml(w, ent, s)).join('')}</ul></details>` : ''}</section>
      <section class="card"><h2>${esc(sessionName(w, last.n))} timesheet</h2>${shortTimesheetHtml(w, last, mine)}<button class="linkish small" data-act="wk-view" data-view="timing" data-stage="${stage}">Full timesheet</button></section>`
      : `<section class="card"><h2>Debriefs</h2><p class="muted">After each session, the debrief for ${esc(sel.name.split(' ')[0])}’s car appears here, with the timesheet.</p></section>`;
  } else if (stage === 'quali') {
    right += `<section class="card">${qualiDebriefHtml(w, ent) || `<h2>Qualifying debrief</h2><p class="muted">It comes when qualifying is over.</p>`}</section>`;
    if (w.status === 'grid') right += `<section class="card"><h2>Grid</h2>${shortQualiHtml(w, mine)}</section>`;
  } else {
    const car = st.cars.find(c => c.id === sel.id);
    right += raceLocked(w) ? `<section class="card"><h2>${esc(sel.name)}</h2>${car && car.status === 'running' ? lockedStatusHtml(w, sel, car) : `<p class="muted">Out: ${esc((car || {}).dnf || '')}</p>`}</section>`
      : (f1PitWallHtml(w) || '');
    right += `<section class="card"><h2>Race log</h2><div class="rail-feed">${lvFeedHtml(w)}</div></section>`;
  }
  h += `<div class="wk-cols" style="--team:${esc(team.color)}">${left}<div class="wk-main">${mid}</div><aside class="wk-side" aria-label="Debrief and timing">${right}</aside></div>`;
  return h;
};

/* =====================================================================
   F1 SIM — team branding.
   Each team can have a logo, a banner photo and a car photo. The team
   principal uploads them from Team HQ (their uploads count while they
   hold the seat), or Race Control does (stored on the team itself). The
   newest valid upload for each picture wins. They show on Team HQ, The
   Grid, the Race Weekend page and driver profiles.
   ===================================================================== */
'use strict';

const BRAND_SLOTS = [
  ['logo', 'Team logo', 'Square works best. Shown beside the team’s name.', 512],
  ['banner', 'Banner photo', 'Wide: the garage, the crew, the crowd. Across the top of Team HQ.', 1800],
  ['car', 'Car photo', 'The car in its livery. On Team HQ and The Grid.', 1600]
];
const isTpOf = (teamId, charId) => F1.seats(teamId).some(s => s.role === 'principal' && s.holderCharId === charId) || list('f1_seats').some(s => s.teamId === teamId && s.role === 'principal' && s.holderCharId === charId);
/* The pictures a team shows now: for each, the newest of Race Control's and the current team principal's. */
function teamBrand(teamId) {
  const t = get('f1_teams', teamId) || {}, out = {};
  BRAND_SLOTS.forEach(([slot]) => {
    const cands = [];
    const rc = (t.brand || {})[slot]; if (rc && rc.at) cands.push(rc);
    list('f1_branding').filter(b => b.teamId === teamId && b.slot === slot && isTpOf(teamId, b.charId) && (get('characters', b.charId) || {}).userId === b.userId).forEach(b => cands.push(b));
    const best = cands.sort((a, b) => String(b.at).localeCompare(String(a.at)))[0];
    if (best && best.url) out[slot] = best.url;
  });
  return out;
}
const canBrand = teamId => S.isGm || !!(S.charId && isTpOf(teamId, S.charId));
async function saveBrand(teamId, slot, url) {
  const c = currentChar();
  if (c && isTpOf(teamId, c.id)) { await Data.put('f1_branding', `${teamId}-${slot}-${c.id}`, { userId: asOwner(), charId: c.id, teamId, slot, url, at: nowIso() }); return; }
  if (!S.isGm) throw { message: 'Only the team principal or Race Control can change the team’s pictures.' };
  const doc = clone(S.store.f1_teams[teamId]); doc.brand = Object.assign({}, doc.brand || {}, { [slot]: { url, at: nowIso() } });
  await Data.put('f1_teams', teamId, doc);
}
CHANGES['brand-upload'] = (v, d, el) => {
  const file = el.files && el.files[0], slot = BRAND_SLOTS.find(s => s[0] === d.slot); if (!file || !slot) return;
  if (!/^image\//.test(file.type)) { toast('Choose a picture: a JPEG, PNG or WebP.', true); return; }
  run(async () => {
    const blob = await shrinkImage(file, slot[3]), assets = await window.claude.use('assets'), up = await assets.upload(blob, { type: 'image/jpeg' });
    await saveBrand(d.team, slot[0], up.url);
    await Data.audit('team.brand', `${F1.team(d.team).name}: new ${slot[1].toLowerCase()}`);
  }, `${slot[1]} saved.`);
  el.value = '';
};
ACTIONS['brand-remove'] = d => askConfirm('Remove this picture?', 'Remove', () => run(async () => { await saveBrand(d.team, d.slot, null); }, 'Picture removed.'), true);

function brandingHtml(tid) {
  const b = teamBrand(tid), can = canBrand(tid), t = F1.team(tid);
  return `<section class="card"><h2>Team branding</h2><p class="muted small">${can ? 'Upload the team’s pictures. They show on Team HQ, The Grid, the Race Weekend page and drivers’ profiles.' : `${esc(t.name)}’s team principal and Race Control set these.`}</p>
    <div class="brand-slots">${BRAND_SLOTS.map(([slot, label, hint]) => `<div class="brand-slot ${slot}">
      <div class="brand-preview">${b[slot] ? `<img src="${esc(b[slot])}" alt="${esc(t.name)} ${esc(label.toLowerCase())}">` : `<span class="muted small">No ${esc(label.toLowerCase())} yet</span>`}</div>
      <p><b>${esc(label)}</b><br><span class="muted small">${esc(hint)}</span></p>
      ${can ? `<div class="btn-row"><label class="btn small file-btn">${b[slot] ? 'Replace' : 'Upload'}<input type="file" accept="image/*" class="sr-only" data-change="brand-upload" data-team="${esc(tid)}" data-slot="${slot}"></label>${b[slot] ? `<button class="btn small ghost" data-act="brand-remove" data-team="${esc(tid)}" data-slot="${slot}">Remove</button>` : ''}</div>` : ''}</div>`).join('')}</div></section>`;
}
/* Team HQ: the banner across the top, and the branding section. */
const _teamViewBrand = ROUTES.team.view;
ROUTES.team.view = function () {
  const html = _teamViewBrand(), teams = F1.teams(); if (!teams.length) return html;
  const my = S.charId ? F1.seats().find(s => s.holderCharId === S.charId) : null, tid = S.ui.teamId || (my && my.teamId) || teams[0].id, b = teamBrand(tid), t = F1.team(tid);
  const banner = b.banner || b.logo || b.car ? `<div class="team-banner" style="--team:${esc(t.color)}">${b.banner ? `<img class="banner-img" src="${esc(b.banner)}" alt="">` : ''}<div class="team-banner-id">${b.logo ? `<img class="team-logo big" src="${esc(b.logo)}" alt="">` : ''}<span>${esc(t.name)}</span></div>${b.car ? `<img class="car-img" src="${esc(b.car)}" alt="${esc(t.name)} car">` : ''}</div>` : '';
  const inTeam = S.isGm || F1.seats(tid).some(s => S.charId && s.holderCharId === S.charId);
  return banner + html + (inTeam || b.logo || b.banner || b.car ? brandingHtml(tid) : '');
};

/* =====================================================================
   F1 SIM — Characters: the showcase, and each character's own page.
   One page, three views of everyone in the league: Cards (portrait
   cards in team colours), By team (the paddock by series and team, with
   branding and open seats) and Register (a filterable directory with a
   preview). Every name links to the character's page: a banner and
   portrait, then particulars and relationships, their story, diary and
   timeline, and their ratings, trophies and race-by-race record.
   ===================================================================== */
'use strict';

const initialsOf = n => String(n || '').split(/\s+/).filter(Boolean).map(x => x[0]).slice(0, 2).join('').toUpperCase();
const showcaseChars = () => list('characters').filter(c => !c.retired && charApproved(c));
/* A character's seats in every series; the one shown first is in the series being viewed. */
function seatsOfChar(charId) { return list('f1_seats').filter(s => s.holderCharId === charId); }
function primarySeat(charId) { const all = seatsOfChar(charId); return all.find(s => ((get('f1_teams', s.teamId) || {}).seriesId || 'f1') === curSeriesId()) || all[0] || null; }
const seriesOfTeam = teamId => seriesDoc(((get('f1_teams', teamId) || {}).seriesId) || 'f1');
function seasonStandingsFor(seriesId) { return standingsOf(seasonWeekendsOf(seriesId, curSeasonId(seriesId))); }

/* Everything the showcase needs about one character. */
function charInfo(c) {
  const pid = f1PcId(c.id), p = F1.person(pid), seat = primarySeat(c.id), team = seat ? get('f1_teams', seat.teamId) : null, series = team ? seriesOfTeam(team.id) : null;
  const rec = f1Record(pid), gps = rec.filter(x => x.w.session === 'gp'), pts = rec.reduce((a, x) => a + (x.r.points || 0), 0);
  let stats;
  if (c.role === 'driver') stats = [[gps.length, 'Races'], [gps.filter(x => x.r.position && x.r.position <= 3).length, 'Podiums'], [pts, 'Points']];
  else if (c.role === 'principal') { const st = team ? seasonStandingsFor(series.id) : { teams: [] }, i = team ? st.teams.findIndex(x => x.teamId === team.id) : -1;
    stats = [[i >= 0 ? st.teams[i].pts : 0, 'Team points'], [i >= 0 ? 'P' + (i + 1) : '–', 'Team'], [teamDevSpends(team ? team.id : '').filter(x => x.charId === c.id).length, 'Dev spends']]; }
  else if (c.role === 'engineer') stats = [[list('f1_weekends').filter(w => Object.values(w.setupBy || {}).indexOf(c.id) !== -1).length, 'Weekends'], [f1AwardsFor(pid).filter(a => a.key === 'setup').length, 'Set-up awards'], [seat ? f1Rapport(seat.teamId, seat.car) : 0, 'Rapport']];
  else { const posts = list('f1_posts').filter(x => x.charId === c.id);
    stats = [[posts.length, 'Posts'], [posts.filter(x => x.kind === 'interview').length, 'Interviews'], [list('f1_diary').filter(x => x.charId === c.id).length, 'Diary']]; }
  const where = team ? `${team.name}${seat.role !== 'principal' ? `, car ${seat.car}` : ''}` : (c.role === 'media' || c.role === 'paddock' ? 'The paddock' : 'Looking for a seat');
  return { c, pid, p, seat, team, series, where, stats, pts, color: team ? team.color : '#56636F', num: c.role === 'driver' ? (c.number || (p && p.num) || '') : '', years: p ? yearsNow(p) : 0 };
}
const charThumb = (c, size) => c.portraitUrl ? `<img class="ppl-thumb" src="${esc(c.portraitUrl)}" alt="" width="${size}" height="${size}" loading="lazy">` : `<span class="ppl-thumb none" style="width:${size}px;height:${size}px" aria-hidden="true">${esc(initialsOf(c.name))}</span>`;
ACTIONS['ppl-view'] = d => { S.ui.pplView = d.view; render(); };
ACTIONS['ppl-role'] = d => { (S.ui.ppl = S.ui.ppl || {}).role = d.role; render(); };
ACTIONS['ppl-search'] = () => render();
ACTIONS['ppl-sel'] = d => { S.ui.pplSel = d.id; render(); };
ACTIONS['ppl-open'] = d => { S.ui.career = d.id; go('career'); };
ACTIONS['ppl-apply'] = d => { S.series = d.series; lsSet('f1sim.series', d.series); go('grid'); };
const roleGroup = r => r === 'paddock' ? 'media' : r;

function filteredInfos() {
  const f = S.ui.ppl = S.ui.ppl || { role: 'all', series: 'all', sort: 'team', q: '' }, q = String(f.q || '').trim().toLowerCase();
  let rows = showcaseChars().map(charInfo).filter(x => (f.role === 'all' || roleGroup(x.c.role) === f.role) && (f.series === 'all' || (x.series && x.series.id === f.series)) && (!q || (x.c.name + ' ' + x.where + ' ' + charRoleName(x.c.role)).toLowerCase().indexOf(q) !== -1));
  const by = { name: (a, b) => String(a.c.name).localeCompare(String(b.c.name)), points: (a, b) => b.pts - a.pts || String(a.c.name).localeCompare(String(b.c.name)),
    newest: (a, b) => String(b.c.createdAt || '').localeCompare(String(a.c.createdAt || '')),
    team: (a, b) => String(a.series ? a.series.id : 'zz').localeCompare(String(b.series ? b.series.id : 'zz')) || String(a.team ? a.team.order : 99).localeCompare(String(b.team ? b.team.order : 99), undefined, { numeric: true }) || CHAR_ROLES.findIndex(r => r[0] === a.c.role) - CHAR_ROLES.findIndex(r => r[0] === b.c.role) };
  return rows.sort(by[f.sort] || by.team);
}
function cardsHtml() {
  const rows = filteredInfos(), f = S.ui.ppl, roles = [['all', 'Everyone'], ['driver', 'Drivers'], ['principal', 'Team principals'], ['engineer', 'Race engineers'], ['media', 'Media and paddock']];
  return `<div class="ppl-filters" role="search">
      <label class="sr-only" for="ppl-q">Search characters</label><input id="ppl-q" type="search" placeholder="Search by name or team" value="${esc(f.q || '')}" data-bind="ui/ppl/q"><button class="btn" data-act="ppl-search">Search</button>
      <div role="group" aria-label="Role" class="chip-row">${roles.map(([k, l]) => `<button class="chip ${f.role === k ? 'on' : ''}" aria-pressed="${f.role === k}" data-act="ppl-role" data-role="${k}">${l}</button>`).join('')}</div>
      <label class="sr-only" for="ppl-series">Series</label>${sel('ppl-series', 'ui/ppl/series', f.series, [['all', 'Every series']].concat(allSeries().map(s => [s.id, s.name])))}
      <label class="sr-only" for="ppl-sort">Sort</label>${sel('ppl-sort', 'ui/ppl/sort', f.sort, [['team', 'Sort: by team'], ['name', 'Sort: by name'], ['points', 'Sort: most points'], ['newest', 'Sort: newest']])}</div>
    <p class="muted small">${plural(rows.length, 'character')}</p>
    ${rows.length ? `<div class="ppl-cards">${rows.map(x => `<button class="ppl-card" data-act="ppl-open" data-id="${esc(x.pid)}" style="--team:${esc(x.color)}">
      <span class="ppl-photo">${x.c.portraitUrl ? `<img src="${esc(x.c.portraitUrl)}" alt="" loading="lazy">` : `<span class="ppl-init" aria-hidden="true">${esc(initialsOf(x.c.name))}</span>`}${x.num ? `<span class="ppl-num">${esc(x.num)}</span>` : ''}</span>
      <span class="ppl-body"><b class="ppl-name">${esc(x.c.name)}</b><span>${esc(charRoleName(x.c.role))}</span><span class="muted small">${esc(x.where)}${x.series ? `, ${esc(x.series.short)}` : ''}</span>
        <span class="ppl-stats">${x.stats.map(([v, l]) => `<span><b>${esc(v)}</b><span>${esc(l)}</span></span>`).join('')}</span></span></button>`).join('')}</div>`
      : '<div class="empty">Nobody matches. Try another role or series.</div>'}`;
}
function byTeamHtml() {
  const f = S.ui.ppl = S.ui.ppl || { role: 'all', series: 'all', sort: 'team', q: '' }, onlyActive = S.ui.pplActive !== false;
  const series = allSeries().filter(s => f.series === 'all' || s.id === f.series);
  const tile = (seat, team) => { const o = f1Occupant(seat), title = seatTitle(seat);
    if (o.player) { const c = get('characters', o.charId) || { name: o.name };
      return `<button class="ppl-seat player" data-act="ppl-open" data-id="${esc(f1PcId(o.charId))}">${charThumb(c, 44)}<span><span class="muted small">${esc(title)}</span><b>${esc(o.name)}</b></span></button>`; }
    if (seat.open) return `<div class="ppl-seat open"><span class="ppl-thumb none" aria-hidden="true" style="width:44px;height:44px">+</span><span><span class="muted small">${esc(title)}</span><b>Open seat</b><button class="linkish small" data-act="ppl-apply" data-series="${esc(team.seriesId || 'f1')}">Apply for this seat</button></span></div>`;
    return `<div class="ppl-seat other"><span class="ppl-thumb none" aria-hidden="true" style="width:44px;height:44px">${esc(initialsOf(o.name))}</span><span><span class="muted small">${esc(title)}</span><b>${o.person ? careerLink(o.person.id, o.name) : esc(o.name)}</b><span class="muted small">${o.person ? (o.person.fictional ? 'Not a player' : 'Real') : 'Not a player'}</span></span></div>`; };
  let h = `<label class="small ppl-toggle"><input type="checkbox" data-bind="ui/pplActive" ${onlyActive ? 'checked' : ''}> Only teams with players or open seats</label>`;
  series.forEach(s => {
    const teams = list('f1_teams').filter(t => (t.seriesId || 'f1') === s.id).sort((a, b) => (a.order || 0) - (b.order || 0))
      .filter(t => !onlyActive || F1.seats(t.id).some(x => x.holderCharId || x.open));
    if (!teams.length) return;
    h += `<section class="ppl-series"><h2>${esc(s.name)}</h2>${teams.map(t => { const b = teamBrand(t.id);
      return `<article class="ppl-team" style="--team:${esc(t.color)}"><div class="ppl-banner">${b.banner ? `<img src="${esc(b.banner)}" alt="">` : ''}<div class="ppl-team-id">${b.logo ? `<img class="team-logo" src="${esc(b.logo)}" alt="">` : ''}<h3>${esc(t.name)}</h3></div></div>
        <div class="ppl-seats">${F1.seats(t.id).map(x => tile(x, t)).join('')}</div></article>`; }).join('')}</section>`;
  });
  const others = showcaseChars().filter(c => c.role === 'media' || c.role === 'paddock' || !primarySeat(c.id));
  if (others.length) h += `<section class="ppl-series"><h2>Media, paddock and free agents</h2><div class="ppl-seats loose">${others.map(c => `<button class="ppl-seat player" data-act="ppl-open" data-id="${esc(f1PcId(c.id))}">${charThumb(c, 44)}<span><span class="muted small">${esc(charRoleName(c.role))}</span><b>${esc(c.name)}</b></span></button>`).join('')}</div></section>`;
  return h;
}
function registerHtml() {
  const g = S.ui.pplReg = S.ui.pplReg || { r: { driver: true, principal: true, engineer: true, media: true }, s: {}, y: { a: true, b: true, c: true } };
  const yb = n => !n ? 'n' : n <= 2 ? 'a' : n <= 6 ? 'b' : 'c', q = String((S.ui.ppl || {}).q || '').trim().toLowerCase();
  const rows = showcaseChars().map(charInfo).filter(x => g.r[roleGroup(x.c.role)] !== false && (!x.series || g.s[x.series.id] !== false) && (yb(x.years) === 'n' || g.y[yb(x.years)] !== false) && (!q || x.c.name.toLowerCase().indexOf(q) !== -1))
    .sort((a, b) => String(a.c.name).localeCompare(String(b.c.name)));
  const pick = rows.find(x => x.c.id === S.ui.pplSel) || rows[0];
  const cb = (path, on, label) => `<label class="reg-check"><input type="checkbox" data-bind="${path}" ${on !== false ? 'checked' : ''}> ${esc(label)}</label>`;
  const rec = x => x.c.role === 'driver' ? `${x.pts} pts, ${plural(x.stats[1][0], 'podium')}` : `${x.stats[0][0]} ${x.stats[0][1].toLowerCase()}`;
  return `<div class="reg-wrap"><aside class="reg-filters" aria-label="Filters">
      <label class="sr-only" for="ppl-q2">Search the register</label><input id="ppl-q2" type="search" placeholder="Search by name" value="${esc((S.ui.ppl || {}).q || '')}" data-bind="ui/ppl/q"><button class="btn small" data-act="ppl-search">Search</button>
      <fieldset><legend>Role</legend>${cb('ui/pplReg/r/driver', g.r.driver, 'Drivers')}${cb('ui/pplReg/r/principal', g.r.principal, 'Team principals')}${cb('ui/pplReg/r/engineer', g.r.engineer, 'Race engineers')}${cb('ui/pplReg/r/media', g.r.media, 'Media and paddock')}</fieldset>
      <fieldset><legend>Series</legend>${allSeries().map(s => cb(`ui/pplReg/s/${s.id}`, g.s[s.id], s.name)).join('')}</fieldset>
      <fieldset><legend>Experience</legend>${cb('ui/pplReg/y/a', g.y.a, '1 to 2 years')}${cb('ui/pplReg/y/b', g.y.b, '3 to 6 years')}${cb('ui/pplReg/y/c', g.y.c, '7 years or more')}</fieldset></aside>
    <div class="card reg-table"><div class="scroll-x"><table class="data"><thead><tr><th>Name</th><th>Role</th><th>Team</th><th>Series</th><th class="num">Years</th><th class="num">Record</th></tr></thead><tbody>
      ${rows.map(x => `<tr class="${pick && x.c.id === pick.c.id ? 'me' : ''}"><td><span class="f1-bar" style="background:${esc(x.color)}"></span><button class="linkish" data-act="ppl-sel" data-id="${esc(x.c.id)}">${esc(x.c.name)}</button></td><td>${esc(charRoleName(x.c.role))}</td><td>${esc(x.team ? x.team.name : x.where)}</td><td>${esc(x.series ? x.series.short : '')}</td><td class="num">${x.years || ''}</td><td class="num">${esc(rec(x))}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">Nobody matches these filters.</td></tr>'}</tbody></table></div></div>
    ${pick ? (() => { const x = pick, c = x.c, diary = list('f1_diary').filter(d => d.charId === c.id).sort((a, b) => String(b.at).localeCompare(String(a.at)))[0], rival = list('f1_relations').find(r => r.charId === c.id && r.kind === 'rival');
      return `<aside class="card reg-preview" style="--team:${esc(x.color)}" aria-label="${esc(c.name)}"><div class="reg-photo">${c.portraitUrl ? `<img src="${esc(c.portraitUrl)}" alt="">` : `<span class="ppl-init" aria-hidden="true">${esc(initialsOf(c.name))}</span>`}</div>
        <h2>${esc(c.name)}${x.num ? ` <span class="muted">#${esc(x.num)}</span>` : ''}</h2><p class="muted small">${esc(charRoleName(c.role))}, ${esc(x.where)}.${c.nationality ? ' ' + esc(c.nationality) + '.' : ''}${x.years ? ` ${plural(x.years, 'year')} of experience.` : ''}</p>
        ${c.bio ? `<p>${esc(String(c.bio).split('\n')[0].slice(0, 220))}</p>` : ''}
        <div class="ppl-stats">${x.stats.map(([v, l]) => `<span><b>${esc(v)}</b><span>${esc(l)}</span></span>`).join('')}</div>
        ${diary ? `<p class="small"><b>Latest diary:</b> ${esc(diary.title)}</p>` : ''}${rival ? `<p class="small"><b>Rival:</b> ${esc((F1.person(rival.otherId) || {}).name || '')}</p>` : ''}
        <button class="btn primary" data-act="ppl-open" data-id="${esc(x.pid)}">Open ${esc(c.name.split(' ')[0])}’s page</button></aside>`; })() : ''}</div>`;
}
route('people', 'Characters', function () {
  const v = S.ui.pplView || 'cards';
  return `<div class="page-head"><div><h1>Characters</h1><p>Everyone racing, running teams and reporting in the league.</p></div>
      <div class="btn-row"><div class="seg" role="tablist" aria-label="View">${[['cards', 'Cards'], ['team', 'By team'], ['register', 'Register']].map(([k, l]) => `<button role="tab" aria-selected="${v === k}" data-act="ppl-view" data-view="${k}">${l}</button>`).join('')}</div>
      <button class="btn primary" data-act="nav" data-route="characters">Create a character</button></div></div>
    ${v === 'team' ? byTeamHtml() : v === 'register' ? registerHtml() : cardsHtml()}`;
});

/* ---------------------------------------------------------------- one character's page */
route('career', 'Character', function () {
  let p = F1.person(S.ui.career);
  const cid = p ? p.charId : (String(S.ui.career || '').indexOf('pc-') === 0 ? String(S.ui.career).slice(3) : null), c = cid ? get('characters', cid) : null;
  if (!p && c) p = { id: f1PcId(c.id), charId: c.id, name: c.name, kind: c.role };
  if (!p) return '<div class="empty">Choose someone from Characters, The Grid or the Championship.</div>';
  const mine = !!(c && (c.userId === S.uid || S.isGm) && S.charId === c.id), isDriver = !p.kind || p.kind === 'driver' || (c && c.role === 'driver');
  const seat = c ? primarySeat(c.id) : F1.seats().find(s => s.defaultPersonId === p.id && !s.holderCharId) || list('f1_seats').find(s => s.defaultPersonId === p.id);
  const team = seat ? get('f1_teams', seat.teamId) : (p.teamId ? get('f1_teams', p.teamId) : null), series = team ? seriesOfTeam(team.id) : null, brand = team ? teamBrand(team.id) : {};
  const color = team ? team.color : '#56636F', rec = f1Record(p.id), gps = rec.filter(x => x.w.session === 'gp'), pts = rec.reduce((a, x) => a + (x.r.points || 0), 0);
  const role = c ? charRoleName(c.role) : (F1_ROLE[p.kind] || 'Driver'), years = yearsNow(p), styleLbl = isDriver && p.style ? (F1_STYLES.find(s => s[0] === p.style) || ['', ''])[1] : '';
  let stats;
  if (isDriver) { const st = series ? seasonStandingsFor(series.id) : { drivers: [] }, i = st.drivers.findIndex(d => d.personId === p.id);
    stats = [['Races', gps.length], ['Podiums', gps.filter(x => x.r.position && x.r.position <= 3).length], ['Points', pts], ['Championship', i >= 0 ? 'P' + (i + 1) : '–']]; }
  else stats = (c ? charInfo(c).stats.map(([v, l]) => [l, v]) : []);
  const awards = f1AwardsFor(p.id), counts = {}; awards.forEach(a => { const k = a.label.replace(/ \(.*\)$/, ''); counts[k] = (counts[k] || 0) + 1; });
  const diary = c ? list('f1_diary').filter(x => x.charId === c.id).sort((a, b) => String(b.at).localeCompare(String(a.at))) : [];
  const rels = list('f1_relations').filter(r => r.personId === p.id || r.otherId === p.id), relKind = k => (REL_KINDS.find(x => x[0] === k) || [k, k])[1], relName = id => (F1.person(id) || {}).name || 'someone';
  const rivals = trackRivals(p.id), tl = timeline(p);
  const eng = isDriver && seat && seat.role === 'driver' ? F1.seats(seat.teamId).find(s => s.role === 'engineer' && s.car === seat.car && s.holderCharId) : null;
  const k = c && seat && typeof activeContract === 'function' ? activeContract(c.id, seat.teamId) : null;
  const ratings = isDriver ? (c ? f1DevApply(Object.assign({}, F1_ROOKIE, p), c.id) : p) : null;
  const where = team ? `${team.name}${seat && seat.role !== 'principal' ? `, car ${seat.car}` : ''}${series ? `, ${series.name}` : ''}` : (c && (c.role === 'media' || c.role === 'paddock') ? 'the paddock' : '');

  let h = `<button class="linkish small" data-act="nav" data-route="people">All characters</button>
  <section class="char-hero" style="--team:${esc(color)}"><div class="char-banner">${brand.banner ? `<img src="${esc(brand.banner)}" alt="">` : ''}</div>
    <div class="char-id"><div class="char-photo">${(c && c.portraitUrl) || (!c && p.portraitUrl) ? `<img src="${esc((c && c.portraitUrl) || p.portraitUrl)}" alt="${esc(p.name)}">` : `<span class="ppl-init" aria-hidden="true">${esc(initialsOf(p.name))}</span>`}</div>
      <div class="char-name"><p class="muted">${brand.logo ? `<img class="team-logo tiny" src="${esc(brand.logo)}" alt="">` : ''}${esc(role)}${where ? `, ${esc(where)}` : ''}${c ? '' : '. Real, not a player'}</p>
        <h1>${p.flag ? esc(p.flag) + ' ' : ''}${esc(p.name)}</h1>
        <p class="muted">${[c && c.nickname ? `“${c.nickname}”` : '', p.num || (c && c.number) ? '#' + (c && c.number || p.num) : '', c && c.nationality, c && c.birthplace ? 'from ' + c.birthplace : '', years ? plural(years, 'year') + ' of experience' : '', styleLbl].filter(Boolean).map(esc).join('. ')}</p></div>
      ${stats.length ? `<div class="stat-strip">${stats.map(([l, v], i) => `<div><span>${esc(l)}</span><b class="${i === stats.length - 1 && isDriver ? 'hi' : ''}">${esc(v)}</b></div>`).join('')}</div>` : ''}</div>
    ${mine ? `<div class="btn-row char-actions"><label class="btn small file-btn">Change portrait<input type="file" accept="image/*" data-change="portrait" data-id="${esc(c.id)}" class="sr-only"></label><button class="btn small" data-act="diary-new">Write in the diary</button><button class="btn small" data-act="conn-jump">Add a connection</button><button class="btn small" data-act="char-edit" data-id="${esc(c.id)}">Edit details</button></div>` : ''}</section>`;

  const left = `<aside class="char-left">
    <section class="card"><h2>Particulars</h2><dl class="rail-defaults">
      ${c && c.helmet ? `<div><dt>Helmet</dt><dd>${esc(c.helmet)}</dd></div>` : ''}${c && c.junior ? `<div><dt>Before Formula 1</dt><dd>${esc(c.junior)}</dd></div>` : ''}
      ${k ? `<div><dt>Contract</dt><dd>£${k.salary}m a season, until ${esc(contractLeft(k))}</dd></div>` : ''}
      ${eng ? `<div><dt>Race engineer</dt><dd>${careerLink(f1PcId(eng.holderCharId), eng.holderName)}${f1Rapport(seat.teamId, seat.car) ? `, ${plural(f1Rapport(seat.teamId, seat.car), 'weekend')} together` : ''}</dd></div>` : ''}
      ${seatsOfChar(cid || '').length > 1 ? `<div><dt>Also races in</dt><dd>${seatsOfChar(cid).filter(s => s.id !== seat.id).map(s => `${esc(seriesOfTeam(s.teamId).name)}, ${esc(F1.team(s.teamId).name)}`).join('<br>')}</dd></div>` : ''}
      ${c && c.faceclaim ? `<div><dt>Face claim</dt><dd>${esc(c.faceclaim)}</dd></div>` : ''}${c && c.discord ? `<div><dt>Discord</dt><dd>${esc(c.discord)}</dd></div>` : ''}
      ${!(c && (c.helmet || c.junior || c.discord || c.faceclaim)) && !k && !eng ? '<p class="muted small">Nothing more yet.</p>' : ''}</dl></section>
    </aside>`;

  const mid = `<div class="char-mid">
    ${c && c.personality ? `<section class="card"><h2>Personality</h2>${paras(c.personality)}</section>` : ''}
    <section class="card"><h2>Backstory</h2>${c && c.bio ? paras(c.bio) : `<p class="muted">${c ? 'No story written yet.' : `${esc(p.name)} is part of today’s real grid.`}</p>`}</section>
    ${flavourCardHtml(c)}
    ${diary.length || mine ? `<section class="card"><h2>Diary</h2>${diary.length ? diary.slice(0, 8).map(d => `<article class="diary"><p class="muted small">${esc(fmtWhen(d.at))}</p><h3>${esc(d.title)}</h3>${paras(d.body)}${mine ? `<button class="btn small ghost" data-act="diary-delete" data-id="${esc(d.id)}">Delete</button>` : ''}</article>`).join('') : '<p class="muted">No entries yet. Diary entries are public.</p>'}</section>` : ''}
    <section class="card"><h2>Timeline</h2>${tl.length ? `<ol class="timeline">${tl.map(x => `<li><span class="muted small">${esc(fmtDate(x.at))}</span> ${esc(x.text)}</li>`).join('')}</ol>` : '<p class="muted small">The story starts at the first race.</p>'}</section></div>`;

  const right = `<aside class="char-right">
    ${isDriver ? `<section class="card"><h2>Ratings</h2>${mine && c ? devPanelHtml(c.id) : `<div class="rating-bars">${F1_RATINGS.map(([key, l]) => { const v = ratings[key]; const max = key === 'mental' ? 10 : 100;
        return v == null ? '' : `<div class="rating-row"><span>${esc(l)}</span><span class="bar" role="img" aria-label="${esc(l)} ${v}"><span style="width:${Math.min(100, v / max * 100)}%"></span></span><b>${esc(v)}</b></div>`; }).join('')}</div>`}</section>` : ''}
    <section class="card"><h2>Trophy cabinet</h2>${awards.length ? `<p>${Object.keys(counts).map(k2 => `<span class="tag trophy">${esc(k2)}${counts[k2] > 1 ? ' ×' + counts[k2] : ''}</span>`).join(' ')}</p>` : '<p class="muted small">Empty, for now.</p>'}</section>
    ${rec.length ? `<section class="card"><h2>Race by race</h2><table class="data compact"><thead><tr><th>Race</th><th class="num">Grid</th><th class="num">Finish</th><th class="num">Pts</th></tr></thead><tbody>${rec.slice().reverse().slice(0, 12).map(x => { const t = get('f1_tracks', x.w.trackId) || {};
        return `<tr><td>${esc(t.name || '')}${x.w.session === 'sprint' ? ' sprint' : ''}${wSeries(x.w) !== 'f1' ? ` <span class="muted small">${esc(seriesDoc(wSeries(x.w)).short)}</span>` : ''}</td><td class="num">${x.r.grid}</td><td class="num">${x.r.position ? 'P' + x.r.position : 'Out'}</td><td class="num">${x.r.points || ''}</td></tr>`; }).join('')}</tbody></table></section>` : ''}
    ${isDriver ? `<button class="btn" data-act="card-open" data-id="${esc(p.id)}" data-kind="card">Make a driver card</button>` : ''}</aside>`;
  const exportBtn = c && (c.userId === S.uid || S.isGm) ? `<div class="btn-row" style="justify-content:flex-end"><button class="btn" data-act="sheet-open" data-id="${esc(c.id)}">Export the character sheet</button></div>` : '';
  return h + exportBtn + `<div class="char-cols" style="--team:${esc(color)}">${left}${mid}${right}</div>` + careerRecordHtml(p, c) + winsHtml(p, c) + (typeof connectionsSheetHtml === 'function' ? connectionsSheetHtml(p, c) : '');
});

/* =====================================================================
   F1 SIM — team development points.
   A team earns 2 development points for every 3 Grands Prix of the
   season. The team principal spends them on the car, a step at a time.
   Points and what they bought reset each season (how much of the car's
   development carries over is Race Control's choice when the new season
   starts). Teams without a player principal spend theirs on pace by
   themselves. Spec series have no car development.
   ===================================================================== */
'use strict';

const RACES_PER_DEV = 3;
const DEV_PTS_PER_BATCH = 2;
const TEAM_DEV_EACH = 2;
const TEAM_DEV = [
  ['carPace', 'Overall pace', 0.3], ['topSpeed', 'Top speed', 0.5], ['cornering', 'Cornering', 0.5],
  ['reliability', 'Reliability', 1.5], ['tyreLife', 'Kindness to tyres', 1.5], ['pitSpeed', 'Pit crew', 1.5]
];
const teamDevEarned = n => Math.floor((n == null ? finishedGps().length : n) / RACES_PER_DEV) * TEAM_DEV_EACH;
const hasPlayerTp = teamId => F1.seats(teamId).some(s => s.role === 'principal' && s.holderCharId);
/* This season's spends by the team's principals (a principal's own records, checked against their character). */
function teamDevSpends(teamId) {
  return list('f1_dev').filter(x => x.kind === 'team' && x.teamId === teamId && recSeason(x) === curSeasonId() && TEAM_DEV.some(d => d[0] === x.attr)
    && (get('characters', x.charId) || {}).role === 'principal' && (get('characters', x.charId) || {}).userId === x.userId)
    .sort((a, b) => String(a.at).localeCompare(String(b.at)));
}
/* Apply the team's development to a car: as many spends as the points so far cover. */
function teamDevApply(teamId, out, n) {
  const earned = teamDevEarned(n); let used = 0;
  if (hasPlayerTp(teamId)) teamDevSpends(teamId).forEach(x => { if (used >= earned) return; const d = TEAM_DEV.find(t => t[0] === x.attr); out[x.attr] = Math.round(((out[x.attr] || 0) + d[2]) * 100) / 100; used += 1; });
  else { out.carPace = Math.round(((out.carPace || 0) + earned * TEAM_DEV[0][2]) * 100) / 100; used = earned; }
  return { earned, used, left: earned - used };
}
ACTIONS['team-dev'] = d => {
  const c = currentChar(), w = F1.live();
  if (!c || !F1.seats(d.team).some(s => s.role === 'principal' && s.holderCharId === c.id)) { toast('Only the team principal spends the team’s development points.', true); return; }
  if (w && w.status !== 'practice') { toast('Car development waits until the race weekend is over.', true); return; }
  const st = teamDevApply(d.team, Object.assign({}, get('f1_teams', d.team)));
  if (st.left < 1) { toast(`No team development points left. The team earns ${TEAM_DEV_EACH} for every ${RACES_PER_DEV} Grands Prix.`, true); return; }
  run(async () => { await Data.put('f1_dev', newId('tdev'), { userId: asOwner(), charId: c.id, teamId: d.team, kind: 'team', attr: d.attr, seasonId: curSeasonId(), at: nowIso() }); },
    `${(TEAM_DEV.find(t => t[0] === d.attr) || [])[1]} improved.`);
};
function teamDevHtml(tid) {
  if (!curSeries().development) return '';
  const team = get('f1_teams', tid), n = finishedGps().length, st = teamDevApply(tid, Object.assign({}, team), n), eff = f1EffectiveTeam(team, n);
  const c = currentChar(), isTp = !!(c && F1.seats(tid).some(s => s.role === 'principal' && s.holderCharId === c.id)), toNext = RACES_PER_DEV - (n % RACES_PER_DEV);
  const counts = {}; if (hasPlayerTp(tid)) teamDevSpends(tid).slice(0, st.used).forEach(x => { counts[x.attr] = (counts[x.attr] || 0) + 1; });
  return `<section class="card"><h2>Team development points</h2>
    <div class="metrics"><div class="metric"><b>${st.left}</b><span>To spend</span></div><div class="metric"><b>${st.earned}</b><span>Earned this season</span></div><div class="metric"><b>${toNext}</b><span>${toNext === 1 ? 'Grand Prix' : 'Grands Prix'} to the next ${TEAM_DEV_EACH}</span></div></div>
    <p class="muted small">The team earns ${TEAM_DEV_EACH} points for every ${RACES_PER_DEV} Grands Prix. Points and what they bought reset each season. ${hasPlayerTp(tid) ? (isTp ? 'Spend them between race weekends.' : 'The team principal spends them.') : 'With no player in charge, the team puts them into pace by itself.'}</p>
    <table class="data compact"><tbody>${TEAM_DEV.map(([k, l, step]) => `<tr><td>${esc(l)}</td><td class="num"><b>${esc(eff[k])}</b>${counts[k] ? ` <span class="f1-up">+${Math.round(counts[k] * step * 10) / 10}</span>` : ''}</td>
      <td class="num">${isTp ? `<button class="btn small" data-act="team-dev" data-team="${esc(tid)}" data-attr="${k}" ${st.left < 1 ? 'disabled' : ''}>+${step} for 1 point</button>` : ''}</td></tr>`).join('')}</tbody></table></section>`;
}
const _teamViewDev = ROUTES.team.view;
ROUTES.team.view = function () {
  const html = _teamViewDev(), teams = F1.teams(); if (!teams.length) return html;
  const my = S.charId ? F1.seats().find(s => s.holderCharId === S.charId) : null, tid = S.ui.teamId || (my && my.teamId) || teams[0].id;
  return html + teamDevHtml(tid);
};

/* =====================================================================
   F1 SIM — timing sheet export.
   An image of the timing at any stage of a weekend: each practice
   session, Q1, Q2 and Q3 (or qualifying in one-session series), the race
   at the current lap, and the result. Two formats: 1. Podium (portrait,
   1080 by 1350: P1 to P3 on podium steps, the rest in two columns) and
   2. Broadcast (widescreen, 1920 by 1080: three big cards and a timing
   tower). Drawn in the browser; anyone downloads it, Race Control can
   post it to Discord. Player characters show their portraits.
   ===================================================================== */
'use strict';

const EXPORT_FORMATS = [['podium', '1. Podium (portrait)'], ['broadcast', '2. Broadcast (widescreen)']];
const TYRE_COL = { soft: '#E10600', medium: '#F5C400', hard: '#F2F2F2', inter: '#2FA84F', wet: '#1D6FD1' };

/* The stages that have timing to export. */
function exportStages(w) {
  const out = [];
  endedSessions(w).forEach(s => out.push([`fp${s.n}`, w.session === 'test' ? `Testing, day ${s.n}` : sessionName(w, s.n) === 'Practice' ? 'Practice' : `Practice ${s.n}`]));
  if (w.quali && w.quali.results) {
    const single = w.state && w.state.rules.qualifying && w.state.rules.qualifying.q2 >= 99, upto = w.status === 'quali' ? (w.qualiStage || 1) : 3;
    if (single) out.push(['q3', 'Qualifying']); else for (let k = 1; k <= upto; k++) out.push([`q${k}`, `Q${k}`]);
  }
  if (w.state && w.state.lap > 0 && !w.state.finished) out.push(['race', `Lap ${w.state.lap} of ${w.state.laps}`]);
  if (w.status === 'finished' && w.session !== 'test') out.push(['result', w.session === 'sprint' ? 'Sprint result' : 'Race result']);
  return out;
}
const fmtRaceTime = s => { const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = (s % 60).toFixed(1).padStart(4, '0'); return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`; };
/* The order and the numbers for a stage. */
function exportRows(w, key) {
  const ents = w.entrants || f1Entrants(), info = id => { const e = ents.find(x => x.id === id) || { id, name: id };
    const c = e.charId ? get('characters', e.charId) : null, p = e.personId ? F1.person(e.personId) : null;
    return { id, code: id, name: e.name || id, team: (get('f1_teams', e.teamId) || {}).name || '', color: f1Colour(e.teamId), num: (c && c.number) || (p && p.num) || '', portrait: (c && c.portraitUrl) || (p && p.portraitUrl) || null }; };
  let rows = [];
  if (/^fp/.test(key)) {
    const s = endedSessions(w).find(x => `fp${x.n}` === key); if (!s) return [];
    const ids = Object.keys(s.times || {}).filter(k => s.times[k]).sort((a, b) => s.times[a] - s.times[b]), best = s.times[ids[0]];
    rows = ids.map((id, i) => Object.assign(info(id), { value: i ? '+' + (s.times[id] - best).toFixed(3) : f1Fmt(best), lap: s.times[id] }));
    Object.keys(s.times || {}).filter(k => !s.times[k]).forEach(id => rows.push(Object.assign(info(id), { value: 'No time' })));
  } else if (/^q/.test(key)) {
    const k = Number(key.slice(1)) - 1, res = w.quali.results, best = r => r.times[k];
    const inIt = res.filter(r => best(r)).sort((a, b) => best(a) - best(b)), fast = inIt.length ? best(inIt[0]) : 0;
    rows = inIt.map((r, i) => Object.assign(info(r.id), { value: i ? '+' + (best(r) - fast).toFixed(3) : f1Fmt(fast) }));
    for (let j = k - 1; j >= 0; j--) res.filter(r => !r.times[j + 1] && r.times[j] && rows.every(x => x.id !== r.id)).sort((a, b) => a.times[j] - b.times[j]).forEach(r => rows.push(Object.assign(info(r.id), { value: `Out in Q${j + 1}` })));
  } else if (key === 'race') {
    const st = w.state, ord = f1Order(st), lead = ord[0];
    rows = ord.map((c, i) => Object.assign(info(c.id), { value: c.status !== 'running' ? 'Out' : i ? '+' + (c.cum - lead.cum).toFixed(1) : 'Leader', tyre: c.status === 'running' ? c.tyre.compound : null, age: c.tyre ? c.tyre.age : 0 }));
  } else {
    const rs = (w.results || []).slice().sort((a, b) => (a.position || 99) - (b.position || 99));
    rows = rs.map((r, i) => Object.assign(info(r.id), { value: !r.position ? 'Out' : i === 0 ? fmtRaceTime(r.time || 0) : String(r.gap || '').replace(/s$/, ''), tyre: null }));
  }
  return rows.map((r, i) => Object.assign(r, { pos: i + 1 }));
}

/* ---------------------------------------------------------------- drawing */
const EXP_THEMES = {
  dark: { bg: '#1C1D22', panel: '#25272D', ink: '#FFFFFF', muted: '#A7ABB3', line: '#3A3D45', photo: '#2E3037', photoInk: '#565A63', step: '#E10600', stepInk: '#FFFFFF' },
  light: { bg: '#E6E9EC', panel: '#FFFFFF', ink: '#142130', muted: '#56636F', line: '#CDD3D8', photo: '#D3D9DE', photoInk: '#9AA6B0', step: '#142130', stepInk: '#F7F8F9' }
};
const cond = (wt, px) => `${wt} ${px}px "Titillium Web", "Arial Narrow", sans-serif`, bodyF = (wt, px) => `${wt} ${px}px "Titillium Web", system-ui, sans-serif`;
function rr(g, x, y, w, h, r) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }
function fitText(g, text, font, size, max) { let s = size; g.font = font(s); while (g.measureText(text).width > max && s > 10) { s -= 2; g.font = font(s); } return s; }
const initials = n => String(n || '').split(/\s+/).map(x => x[0]).join('').slice(0, 2).toUpperCase();
async function loadImg(url) { if (!url) return null; try { const img = new Image(); img.crossOrigin = 'anonymous'; await new Promise((ok, bad) => { img.onload = ok; img.onerror = bad; img.src = url; }); return img; } catch (e) { return null; } }
function drawPhoto(g, img, x, y, w, h, r, row, T) {
  g.save(); rr(g, x, y, w, h, r); g.clip(); g.fillStyle = T.photo; g.fillRect(x, y, w, h);
  if (img) { const s = Math.max(w / img.width, h / img.height), iw = img.width * s, ih = img.height * s; g.drawImage(img, x + (w - iw) / 2, y + (h - ih) / 2, iw, ih); }
  else { g.fillStyle = T.photoInk; g.textAlign = 'center'; g.textBaseline = 'middle'; g.font = cond(700, Math.round(Math.min(w, h) * 0.38)); g.fillText(initials(row.name), x + w / 2, y + h / 2); }
  g.restore(); g.textAlign = 'left'; g.textBaseline = 'alphabetic';
}
/* The league logo (when Race Control has uploaded one) or the F1 SIM mark, then the name. Returns where it ends. */
function drawMark(g, x, y, T, logo) {
  let tx = x + 38;
  if (logo) { const h = 34, w = Math.min(160, logo.width / logo.height * h); g.drawImage(logo, x, y - 4, w, h); tx = x + w + 12; }
  else [[0, 0, T.ink], [13, 13, T.ink], [13, 0, T.line], [0, 13, T.line]].forEach(([dx, dy, c]) => { g.fillStyle = c; g.fillRect(x + dx, y + dy, 13, 13); });
  g.fillStyle = T.ink; g.font = cond(700, 30); g.fillText('F1 SIM', tx, y + 24); return tx + g.measureText('F1 SIM').width;
}
function tyreDot(g, x, y, r, compound, T) { g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.lineWidth = Math.max(3, r / 3); g.strokeStyle = TYRE_COL[compound] || T.muted; g.stroke(); g.fillStyle = T.ink; g.font = cond(700, Math.round(r * 1.1)); g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText((compound || '').charAt(0).toUpperCase(), x, y + 1); g.textAlign = 'left'; g.textBaseline = 'alphabetic'; }

async function drawTiming(w, key, format, theme) {
  const T = EXP_THEMES[theme] || EXP_THEMES.dark, rows = exportRows(w, key), stage = (exportStages(w).find(s => s[0] === key) || ['', ''])[1];
  const t = get('f1_tracks', w.trackId) || {}, race = key === 'race' || key === 'result', top = rows.slice(0, 3), rest = rows.slice(3), isTest = w.session === 'test';
  try { await Promise.all(['700 100px "Titillium Web"', '900 100px "Titillium Web"', '600 30px "Titillium Web"'].map(f => document.fonts.load(f))); } catch (e) { /* fall back */ }
  const imgs = await Promise.all(top.map(r => loadImg(r.portrait))), logo = await loadImg(leagueLogo());
  const wide = format === 'broadcast', W = wide ? 1920 : 1080, H = wide ? 1080 : 1350, cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const g = cv.getContext('2d'); g.fillStyle = T.bg; g.fillRect(0, 0, W, H);
  const title = isTest ? `Pre-season testing, ${t.circuit || t.name || ''}` : `${t.name || ''}${w.session === 'sprint' ? ' Sprint' : ''}`, sub = race ? 'Gaps to the leader' : 'Best laps';
  if (!wide) {
    drawMark(g, 60, 56, T, logo); g.font = cond(600, 24); g.fillStyle = T.muted; g.textAlign = 'right'; g.fillText(`Round ${t.round || ''}, ${t.circuit || ''}`.trim(), W - 60, 80); g.textAlign = 'left';
    g.font = cond(600, 32); g.fillText(title, 60, 150); fitText(g, stage, s => cond(700, s), 116, W - 120); g.fillStyle = T.ink; g.fillText(stage, 58, 252);
    g.fillStyle = '#E10600'; g.beginPath(); g.moveTo(68, 284); g.lineTo(150, 284); g.lineTo(144, 292); g.lineTo(62, 292); g.closePath(); g.fill();
    /* Podium: P2, P1, P3. */
    const colW = (W - 120 - 36) / 3, baseY = 860, cardH = [450, 400, 370], stepH = [110, 72, 44];
    [1, 0, 2].forEach((i, slot) => { const r = top[i]; if (!r) return; const x = 60 + slot * (colW + 18), y = baseY - stepH[i] - cardH[i];
      g.save(); rr(g, x, y, colW, cardH[i], 16); g.clip(); g.fillStyle = r.color; g.fillRect(x, y, colW, cardH[i]); g.restore();
      drawPhoto(g, imgs[i], x + 8, y + 8, colW - 16, cardH[i] - 118, 10, r, T);
      if (r.num) { g.font = cond(700, 58); g.fillStyle = '#FFFFFF'; g.textAlign = 'right'; g.shadowColor = 'rgba(0,0,0,0.45)'; g.shadowBlur = 8; g.fillText(String(r.num), x + colW - 18, y + 62); g.shadowBlur = 0; g.textAlign = 'left'; }
      g.fillStyle = T.panel; g.fillRect(x, y + cardH[i] - 104, colW, 104); g.fillStyle = r.color; g.fillRect(x, y + cardH[i] - 104, colW, 7);
      g.fillStyle = T.ink; fitText(g, r.name, s => cond(700, s), 34, colW - 28); g.fillText(r.name, x + 14, y + cardH[i] - 58);
      g.font = bodyF(500, 18); g.fillStyle = T.muted; g.fillText(r.team, x + 14, y + cardH[i] - 24); g.font = bodyF(600, 20); g.fillStyle = T.ink; g.textAlign = 'right'; g.fillText(r.value, x + colW - 14, y + cardH[i] - 24); g.textAlign = 'left';
      g.fillStyle = T.step; g.fillRect(x, baseY - stepH[i], colW, stepH[i]); g.fillStyle = T.stepInk; g.font = cond(700, Math.min(60, stepH[i] - 6)); g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(`P${r.pos}`, x + colW / 2, baseY - stepH[i] / 2 + 2); g.textAlign = 'left'; g.textBaseline = 'alphabetic'; });
    /* The rest, in two columns. */
    const per = Math.ceil(rest.length / 2), rh = Math.min(36, Math.floor(380 / Math.max(1, per))), cw = (W - 120 - 36) / 2;
    rest.forEach((r, k) => { const col = k < per ? 0 : 1, x = 60 + col * (cw + 36), y = 900 + (k % per) * rh;
      g.fillStyle = T.line; g.fillRect(x, y + rh - 1, cw, 1);
      g.fillStyle = T.muted; g.font = cond(700, Math.min(24, rh - 8)); g.fillText(String(r.pos), x, y + rh - 10);
      g.fillStyle = r.color; g.fillRect(x + 42, y + 7, 6, rh - 14);
      g.fillStyle = T.ink; g.font = cond(700, Math.min(24, rh - 8)); g.fillText(r.code, x + 58, y + rh - 10);
      g.fillStyle = T.muted; g.font = bodyF(500, Math.min(18, rh - 12)); const nm = r.name; g.fillText(nm.length > 18 ? nm.slice(0, 17) + '…' : nm, x + 122, y + rh - 11);
      g.fillStyle = T.ink; g.font = bodyF(600, Math.min(19, rh - 12)); g.textAlign = 'right'; g.fillText(r.value, x + cw, y + rh - 11); g.textAlign = 'left'; });
    g.fillStyle = T.muted; g.font = bodyF(500, 17); g.fillText(sub, 60, H - 40); g.textAlign = 'right'; g.fillText(stampText(), W - 60, H - 40); g.textAlign = 'left';
  } else {
    const me = drawMark(g, 56, 52, T, logo); g.fillStyle = T.line; g.fillRect(me + 20, 50, 2, 34); g.fillStyle = T.ink; g.font = cond(700, 44); g.fillText(title, me + 42, 84);
    g.font = cond(700, 34); const sw = g.measureText(stage).width + (key === 'race' ? 64 : 40); rr(g, W - 56 - sw, 44, sw, 52, 26); g.fillStyle = T.panel; g.fill();
    if (key === 'race') { g.beginPath(); g.arc(W - 56 - sw + 28, 70, 8, 0, Math.PI * 2); g.fillStyle = '#E10600'; g.fill(); }
    g.fillStyle = T.ink; g.fillText(stage, W - 56 - sw + (key === 'race' ? 46 : 20), 82);
    /* Three cards, stacked. */
    const cx = 56, cw = W - 56 - 640 - 36 - 56, ch = 270, gap = 18;
    top.forEach((r, i) => { const y = 126 + i * (ch + gap);
      rr(g, cx, y, cw, ch, 14); g.fillStyle = T.panel; g.fill();
      g.save(); rr(g, cx, y, cw, ch, 14); g.clip(); g.fillStyle = r.color; g.fillRect(cx, y, 180, ch); g.restore();
      g.fillStyle = '#FFFFFF'; g.shadowColor = 'rgba(0,0,0,0.35)'; g.shadowBlur = 10; g.font = cond(700, 150); g.textAlign = 'center'; g.fillText(String(r.pos), cx + 90, y + ch / 2 + 52); g.shadowBlur = 0; g.textAlign = 'left';
      drawPhoto(g, imgs[i], cx + 206, y + 24, 210, ch - 48, 10, r, T);
      g.fillStyle = T.muted; g.font = cond(600, 28); g.fillText(r.team + (r.num ? `  #${r.num}` : ''), cx + 446, y + 76);
      g.fillStyle = T.ink; fitText(g, r.name, s => cond(700, s), 76, cw - 446 - 300); g.fillText(r.name, cx + 446, y + 146);
      if (r.tyre) { tyreDot(g, cx + 462, y + 196, 16, r.tyre, T); g.fillStyle = T.muted; g.font = bodyF(500, 22); g.fillText(`${RaceEngine.COMPOUNDS[r.tyre].label}s, ${r.age} laps old`, cx + 490, y + 204); }
      g.fillStyle = T.ink; g.font = cond(700, 66); g.textAlign = 'right'; g.fillText(r.value, cx + cw - 36, y + 150);
      g.fillStyle = T.muted; g.font = bodyF(500, 20); g.fillText(i === 0 ? (race ? (key === 'result' ? 'Race time' : 'Leading') : 'Fastest') : (race ? 'To the leader' : 'To the fastest'), cx + cw - 36, y + 186); g.textAlign = 'left'; });
    /* The timing tower. */
    const tx = W - 56 - 640, ty = 126, th = H - 126 - 48; rr(g, tx, ty, 640, th, 14); g.fillStyle = T.panel; g.fill();
    const rh = Math.min(42, Math.floor((th - 70) / Math.max(1, rest.length)));
    g.fillStyle = T.muted; g.font = bodyF(500, 17); g.fillText('Pos', tx + 22, ty + 38); g.fillText('Driver', tx + 104, ty + 38); g.textAlign = 'right'; g.fillText('Gap', tx + 560, ty + 38); g.textAlign = 'left'; if (race) g.fillText('Tyre', tx + 584, ty + 38);
    rest.forEach((r, k) => { const y = ty + 56 + k * rh;
      g.fillStyle = T.line; g.fillRect(tx + 22, y + rh - 1, 596, 1);
      g.fillStyle = T.muted; g.font = cond(700, Math.min(26, rh - 10)); g.fillText(String(r.pos), tx + 22, y + rh - 11);
      g.fillStyle = r.color; g.fillRect(tx + 76, y + 8, 7, rh - 16);
      g.fillStyle = T.ink; g.font = cond(700, Math.min(28, rh - 10)); g.fillText(r.code, tx + 104, y + rh - 11);
      g.fillStyle = T.muted; g.font = bodyF(500, Math.min(19, rh - 14)); const nm = r.team; g.fillText(nm.length > 16 ? nm.slice(0, 15) + '…' : nm, tx + 190, y + rh - 12);
      g.fillStyle = T.ink; g.font = bodyF(600, Math.min(21, rh - 14)); g.textAlign = 'right'; g.fillText(r.value, tx + 560, y + rh - 12); g.textAlign = 'left';
      if (r.tyre) tyreDot(g, tx + 600, y + rh / 2, Math.min(13, rh / 3), r.tyre, T); });
    g.fillStyle = T.muted; g.font = bodyF(500, 16); g.textAlign = 'right'; g.fillText(stampText(), W - 56, H - 16); g.textAlign = 'left';
  }
  return new Promise(ok => cv.toBlob(ok, 'image/png'));
}

/* ---------------------------------------------------------------- the export drawer */
ACTIONS['tx-open'] = d => {
  const w = get('f1_weekends', d.id) || F1.live(); if (!w) return;
  const st = exportStages(w); if (!st.length) { toast('Nothing to export yet: run a session first.', true); return; }
  S.ui.tx = { wid: w.id, key: st[st.length - 1][0], format: 'podium', theme: 'dark', url: null, blob: null, channel: '' }; openDrawer('tx'); txRefresh();
  if (S.isGm) discordChannels().then(() => renderOverlay()).catch(() => {});
};
async function txRefresh() {
  const x = S.ui.tx; if (!x) return; const w = get('f1_weekends', x.wid); if (!w) return;
  const blob = await drawTiming(w, x.key, x.format, x.theme); if (S.ui.tx !== x) return;
  if (x.url) URL.revokeObjectURL(x.url); x.blob = blob; x.url = URL.createObjectURL(blob); renderOverlay();
}
CHANGES['tx-set'] = (v, d) => { const x = S.ui.tx; if (!x) return; x[d.field] = v; if (d.field === 'channel') { renderOverlay(); return; } x.url = null; renderOverlay(); txRefresh(); };
DRAWERS.tx = function () {
  const x = S.ui.tx || {}, w = get('f1_weekends', x.wid); if (!w) return '';
  const t = get('f1_tracks', w.trackId) || {}, opt = (field, list2) => `<select id="tx-${field}" data-change="tx-set" data-field="${field}">${list2.map(([k, l]) => `<option value="${k}" ${x[field] === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  return `<header><div><h2>Export timing</h2><p>${esc(t.name || '')}${w.session === 'sprint' ? ' sprint' : ''}. Download it, or post it to Discord.</p></div><button class="btn ghost" data-act="close-drawer">Close</button></header>
    <div class="body"><div class="form-grid">
      <label class="field">Stage${opt('key', exportStages(w))}</label>
      <label class="field">Format${opt('format', EXPORT_FORMATS)}</label>
      <label class="field">Look${opt('theme', [['dark', 'Carbon'], ['light', 'Light']])}</label></div>
    ${x.url ? `<img class="card-preview tx-preview" src="${x.url}" alt="The timing sheet image">` : '<p class="muted">Drawing the timing sheet…</p>'}
    ${S.isGm ? `<label class="field" style="max-width:360px">Discord channel${opt('channel', [['', `Automatic: #${S.discordCh ? pickChannel(x.key === 'result' ? 'results' : 'timing', wSeries(w), S.discordCh) : '…'}`]].concat((S.discordCh || []).map(c => [c, '#' + c])))}</label>` : ''}
    <div class="btn-row"><button class="btn primary" data-act="tx-download" ${x.url ? '' : 'disabled'}>Download</button>${S.isGm ? `<button class="btn" data-act="tx-discord" ${x.url ? '' : 'disabled'}>Post to Discord</button>` : ''}${x.posted ? `<span class="tag player">Posted to #${esc(x.posted)}</span>` : ''}</div></div>`;
};
ACTIONS['tx-download'] = () => { const x = S.ui.tx; if (!x || !x.url) return; const w = get('f1_weekends', x.wid), a = document.createElement('a'); a.href = x.url; a.download = `${w.trackId}-${x.key}-${x.format}.png`; document.body.appendChild(a); a.click(); a.remove(); };
ACTIONS['tx-discord'] = () => { const x = S.ui.tx; if (!x || !x.blob) return; const w = get('f1_weekends', x.wid), t = get('f1_tracks', w.trackId) || {}, stage = (exportStages(w).find(s => s[0] === x.key) || ['', ''])[1];
  run(async () => { const ch = await discordSend(x.key === 'result' ? 'results' : 'timing', { content: `**${t.name || ''}${w.session === 'sprint' ? ' sprint' : ''}: ${stage}**` }, { blob: x.blob, name: `${w.trackId}-${x.key}.png` }, x.channel);
    x.posted = ch; await Data.audit('discord.timing', `${t.name}: ${stage} timing posted to Discord #${ch}`); }, 'Posted to Discord.'); };
function exportButtonHtml(w) { return w && exportStages(w).length ? `<button class="btn small" data-act="tx-open" data-id="${esc(w.id)}">Export timing</button>` : ''; }

/* The button sits beside the stage strip on every weekend page. */
const _lvStagesTx = lvStagesHtml;
lvStagesHtml = function (w) { const h = _lvStagesTx(w), b = exportButtonHtml(w); return b ? `<div class="stages-row">${h}${b}</div>` : h; };

/* =====================================================================
   F1 SIM — league logo and Discord channels.
   Race Control uploads the league's logo; plain background around it is
   trimmed off automatically. It shows in the top bar, on timing exports
   and on driver cards.
   Discord posts go through webhooks kept as Cloudflare secrets (the
   relay in functions/api/discord.js). Each kind of post has its own
   optional channel, then falls back: for a Formula 2 timing export it
   tries f2-timing, then timing, then default. Race Control can also pick
   a channel by hand when exporting.
   ===================================================================== */
'use strict';

const leagueLogo = () => (get('f1_settings', 'league') || {}).logoUrl || null;
/* Cut away the plain border around a logo (a wallpaper with the logo in the middle, say). */
async function trimImage(file) {
  const url = URL.createObjectURL(file), img = new Image();
  await new Promise((ok, bad) => { img.onload = ok; img.onerror = bad; img.src = url; });
  const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const g = c.getContext('2d'); g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height).data, bg = [d[0], d[1], d[2], d[3]];
  let x0 = c.width, y0 = c.height, x1 = -1, y1 = -1;
  for (let y = 0; y < c.height; y += 2) for (let x = 0; x < c.width; x += 2) {
    const i = (y * c.width + x) * 4;
    if (Math.abs(d[i] - bg[0]) > 40 || Math.abs(d[i + 1] - bg[1]) > 40 || Math.abs(d[i + 2] - bg[2]) > 40 || Math.abs(d[i + 3] - bg[3]) > 40) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  URL.revokeObjectURL(url);
  if (x1 < 0) return file;
  const pad = Math.round(Math.max(x1 - x0, y1 - y0) * 0.04), sx = Math.max(0, x0 - pad), sy = Math.max(0, y0 - pad), sw = Math.min(c.width, x1 + pad) - sx, sh = Math.min(c.height, y1 + pad) - sy;
  const k = Math.min(1, 900 / Math.max(sw, sh)), o = document.createElement('canvas'); o.width = Math.round(sw * k); o.height = Math.round(sh * k);
  o.getContext('2d').drawImage(c, sx, sy, sw, sh, 0, 0, o.width, o.height);
  return new Promise(ok => o.toBlob(ok, 'image/png'));
}
CHANGES['league-logo'] = (v, d, el) => {
  const file = el.files && el.files[0]; if (!file || !S.isGm) return;
  if (!/^image\//.test(file.type)) { toast('Choose a picture: a PNG, JPEG or WebP.', true); return; }
  run(async () => {
    const blob = await trimImage(file), assets = await window.claude.use('assets'), up = await assets.upload(blob, { type: 'image/png' });
    await Data.put('f1_settings', 'league', Object.assign({}, get('f1_settings', 'league') ? clone(S.store.f1_settings.league) : {}, { logoUrl: up.url, logoAt: nowIso() }));
    await Data.audit('league.logo', 'New league logo');
  }, 'League logo saved.');
  el.value = '';
};
ACTIONS['league-logo-remove'] = () => askConfirm('Remove the league logo?', 'Remove', () => run(async () => {
  await Data.put('f1_settings', 'league', Object.assign({}, clone(S.store.f1_settings.league || {}), { logoUrl: null }));
}, 'League logo removed.'), true);

/* ---------------------------------------------------------------- Discord channels */
const DISCORD_PURPOSES = [
  ['results', 'Race results and result exports', 'DISCORD_WEBHOOK_RESULTS'],
  ['timing', 'Practice, qualifying and live timing exports', 'DISCORD_WEBHOOK_TIMING'],
  ['announcements', 'Race Control announcements', 'DISCORD_WEBHOOK_ANNOUNCEMENTS'],
  ['cards', 'Driver cards (signings, poles, wins, Driver of the Day)', 'DISCORD_WEBHOOK_CARDS'],
  ['calendar', 'The season calendar', 'DISCORD_WEBHOOK_CALENDAR'],
  ['standings', 'Championship standings', 'DISCORD_WEBHOOK_STANDINGS'],
  ['approvals', 'Character approvals (acceptance cards with an @mention)', 'DISCORD_WEBHOOK_APPROVALS']
];
async function discordChannels(force) {
  if (S.discordCh && !force) return S.discordCh;
  const api = await window.claude.use('discord'); S.discordCh = await api.channels(); return S.discordCh;
}
function pickChannel(purpose, seriesId, list) { return [`${seriesId}-${purpose}`, purpose, 'default'].find(c => list.indexOf(c) !== -1) || list[0] || 'default'; }
/* Post to the right channel for this kind of post (or the one chosen by hand). Says which channel it went to. */
async function discordSend(purpose, payload, file, chosen) {
  const api = await window.claude.use('discord'), list = await discordChannels().catch(() => ['default']);
  const ch = chosen && list.indexOf(chosen) !== -1 ? chosen : pickChannel(purpose, curSeriesId(), list);
  S.discordLast = await api.post(Object.assign({ channel: ch, payload }, file ? { file } : {}));
  return ch;
}
ACTIONS['discord-check'] = () => { S.ui.dcErr = null; discordChannels(true).then(() => render()).catch(e => { S.ui.dcErr = e.message || String(e); render(); }); };
function leaguePanelHtml() {
  const logo = leagueLogo(), list = S.discordCh;
  const rows = DISCORD_PURPOSES.map(([k, l, env]) => { const ch = list ? pickChannel(k, curSeriesId(), list) : null;
    return `<tr><td>${esc(l)}</td><td><code>${esc(env)}</code></td><td>${!list ? '<span class="muted">Not checked</span>' : list.indexOf(k) !== -1 || list.indexOf(`${curSeriesId()}-${k}`) !== -1 ? `<span class="tag player">#${esc(ch)}</span>` : `<span class="muted">Falls back to #${esc(ch)}</span>`}</td></tr>`; }).join('');
  return `<section class="card"><h2>League logo</h2><p class="muted small">Shown in the top bar, on timing exports and on driver cards. Plain background around the logo is trimmed off when you upload it.</p>
      <div class="league-logo-row"><div class="brand-preview">${logo ? `<img src="${esc(logo)}" alt="League logo">` : '<span class="muted small">No logo yet</span>'}</div>
      <div class="btn-row"><label class="btn small file-btn">${logo ? 'Replace' : 'Upload a logo'}<input type="file" accept="image/*" class="sr-only" data-change="league-logo"></label>${logo ? '<button class="btn small ghost" data-act="league-logo-remove">Remove</button>' : ''}</div></div></section>
    <section class="card"><h2>Discord channels</h2><p class="muted small">Each kind of post can have its own Discord webhook, added in Cloudflare as a secret with the name shown (SETUP.md, Discord). Anything without its own goes to <code>DISCORD_WEBHOOK</code>. For a separate channel per series, put the series code in the name: <code>DISCORD_WEBHOOK_F2_RESULTS</code>.</p>
      <div class="scroll-x"><table class="data compact"><thead><tr><th>Posts</th><th>Webhook secret</th><th>Goes to</th></tr></thead><tbody>${rows}</tbody></table></div>
      ${list ? `<p class="small">Channels set up: ${list.map(c => `<span class="tag">#${esc(c)}</span>`).join(' ') || 'none'}.</p>` : ''}${S.ui.dcErr ? `<p class="small warn-note">${esc(S.ui.dcErr)}</p>` : ''}
      <div class="btn-row"><button class="btn small" data-act="discord-check">${list ? 'Check again' : 'Check the channels'}</button></div></section>`;
}

/* =====================================================================
   F1 SIM — pre-season testing.
   Race Control opens testing at any circuit, like a weekend with three
   test days and no qualifying or race. Each day has 6 runs per car and
   runs like a full practice session: weather, red flags, crashes,
   failures, timesheets and debriefs. Testing doesn't count for the
   championship, money, power units or development points, but the
   engineer and driver working together builds their rapport.
   ===================================================================== */
'use strict';

ACTIONS['test-finish'] = () => {
  const w = F1.live(); if (!w || w.session !== 'test') return;
  const done = endedSessions(w).length;
  askConfirm(done < sessionsOf(w) ? `Finish testing after ${plural(done, 'day')}? The days not run are skipped.` : 'Finish testing? The timesheets stay in the weekend’s record.', 'Finish testing', () => run(async () => {
    const doc = clone(S.store.f1_weekends[w.id]), ents = f1Entrants().map(e => { const o = Object.assign({}, e); delete o.v3; return o; });
    /* The engineer (or whoever ran the car) and the driver worked together: it counts towards their rapport. */
    const setupBy = {}; ents.forEach(e => { const r = lastSetupRun(w, e.id); if (r) setupBy[e.id] = r.charId; });
    Object.assign(doc, { status: 'finished', finishedAt: nowIso(), entrants: ents, results: [], setupBy });
    await Data.put('f1_weekends', w.id, doc);
    await Data.audit('f1.testing', `Testing at ${(F1.track(w.trackId) || {}).name || w.trackId} finished`);
  }, 'Testing finished.'));
};
/* Every day's timesheet, and each car's best across the whole test. */
function testingSummaryHtml(w) {
  const days = endedSessions(w), best = {};
  days.forEach(s => Object.keys(s.times || {}).forEach(id => { const t = s.times[id]; if (t && (!best[id] || t < best[id].t)) best[id] = { t, day: s.n }; }));
  const ents = w.entrants || f1Entrants(), ids = Object.keys(best).sort((a, b) => best[a].t - best[b].t), top = ids.length ? best[ids[0]].t : 0;
  return `<section class="card"><h2>Fastest of the test</h2>${ids.length ? `<div class="scroll-x"><table class="data compact timing"><thead><tr><th>P</th><th>Driver</th><th class="num">Best</th><th class="num">Gap</th><th class="num">Day</th></tr></thead><tbody>${ids.map((id, i) => { const e = ents.find(x => x.id === id) || {};
      return `<tr class="${e.charId ? 'me' : ''}"><td>${i + 1}</td><td><span class="f1-bar" style="background:${esc(f1Colour(e.teamId))}"></span>${esc(e.name || id)}${e.charId ? ' <span class="tag player">Player</span>' : ''}</td><td class="num">${f1Fmt(best[id].t)}</td><td class="num">${i ? '+' + (best[id].t - top).toFixed(3) : ''}</td><td class="num">${best[id].day}</td></tr>`; }).join('')}</tbody></table></div>` : '<p class="muted">No days were run.</p>'}
      <p class="muted small">Testing doesn’t count for the championship. Times depend on fuel, tyres and programme, so read them with care.</p></section>
    ${days.slice().reverse().map(s => `<details class="card"><summary><b>${esc(sessionName(w, s.n))}</b></summary><div class="scroll-x">${timesheetHtml(w, s)}</div></details>`).join('')}`;
}
/* The stage strip for testing: the three days, then done. */
const _lvStagesTest = lvStagesHtml;
lvStagesHtml = function (w) {
  if (w.session !== 'test') return _lvStagesTest(w);
  const done = endedSessions(w).length, cur = w.status === 'finished' ? sessionsOf(w) + 1 : done + 1;
  const items = [...Array(sessionsOf(w)).keys()].map(i => `Day ${i + 1}`).concat(['Done']);
  const strip = `<ol class="stages" aria-label="Testing">${items.map((l, i) => `<li class="${i + 1 < cur ? 'done' : i + 1 === cur ? 'now' : ''}">${esc(l)}</li>`).join('')}</ol>`;
  const b = exportButtonHtml(w); return b ? `<div class="stages-row">${strip}${b}</div>` : strip;
};

/* =====================================================================
   F1 SIM — the calendar.
   Every round of the season for the series being shown, with testing
   first: done (podium, pole, Driver of the Day), happening now, next, or
   still to come (the circuit, and who won there last time). Clicking a
   round that has happened opens that weekend in full. Race Control can
   give each round a date.
   ===================================================================== */
'use strict';

const roundDate = (s, trackId) => ((s.dates || {})[trackId]) || '';
const fmtDay = d => { try { return new Date(d + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }); } catch (e) { return d; } };
ACTIONS['cal-open'] = d => { const w = get('f1_weekends', d.id); if (!w) return; S.ui.f1view = w.status === 'finished' ? w.id : null; go('weekend'); };
ACTIONS['cal-filter'] = d => { S.ui.calFilter = d.f; render(); };
ACTIONS['cal-dates-save'] = () => {
  const s = curSeries(), f = S.ui.form.calDates || {}, dates = Object.assign({}, s.dates || {});
  Object.keys(f).forEach(k => { if (f[k]) dates[k] = f[k]; else delete dates[k]; });
  run(async () => { await Data.put('f1_series', s.id, Object.assign(get('f1_series', s.id) ? clone(S.store.f1_series[s.id]) : { template: s.id, activeSeason: curSeasonId() }, { dates })); S.ui.form.calDates = null; S.ui.calEdit = false; }, 'Dates saved.');
};
ACTIONS['cal-edit'] = () => { S.ui.calEdit = !S.ui.calEdit; render(); };

function podiumLine(w) {
  const rs = (w.results || []).filter(r => r.position && r.position <= 3).sort((a, b) => a.position - b.position);
  return rs.map(r => `<li><span class="cal-pos">${r.position}</span><span class="f1-bar" style="background:${esc(f1Colour(r.teamId))}"></span>${esc(r.name)}${r.charId ? ' <span class="tag player">Player</span>' : ''}</li>`).join('');
}
function lastTimeHere(s, trackId) {
  const w = list('f1_weekends').filter(x => wSeries(x) === s.id && x.trackId === trackId && x.session === 'gp' && x.status === 'finished' && wSeason(x) !== curSeasonId())
    .sort((a, b) => String(b.finishedAt).localeCompare(String(a.finishedAt)))[0];
  if (!w) return '';
  const win = (w.results || [])[0], season = seasonDoc(wSeason(w));
  return win ? `Last time here (${esc(season.name)}): ${esc(win.name)} won.` : '';
}
route('calendar', 'Calendar', function () {
  const s = curSeries(), season = curSeason(), tracks = F1.tracks(), ws = F1.weekends(), filter = S.ui.calFilter || 'all';
  if (!tracks.length) return `<div class="page-head"><div><h1>Calendar</h1><p>${esc(s.name)} has no circuits yet.</p></div></div>`;
  const byTrack = id => ws.filter(w => w.trackId === id && w.session !== 'test').sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const doneGp = id => byTrack(id).find(w => w.session === 'gp' && w.status === 'finished');
  const nextId = (tracks.find(t => !doneGp(t.id) && !byTrack(t.id).some(w => w.status !== 'finished')) || {}).id;
  const tests = ws.filter(w => w.session === 'test').sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const edit = S.isGm && S.ui.calEdit, df = S.ui.form.calDates = S.ui.form.calDates || {};
  const done = tracks.filter(t => doneGp(t.id)).length;
  const cards = tracks.map(t => {
    const wk = byTrack(t.id), gp = wk.find(w => w.session === 'gp'), sprint = wk.find(w => w.session === 'sprint'), live = wk.find(w => w.status !== 'finished');
    const state = live ? 'live' : gp && gp.status === 'finished' ? 'done' : t.id === nextId ? 'next' : 'later';
    if (filter === 'done' && state !== 'done') return ''; if (filter === 'tocome' && state === 'done') return '';
    const pole = gp && gp.quali && gp.quali.grid ? (gp.entrants || []).find(e => e.id === gp.quali.grid[0]) : null, dotd = gp ? dotdWinner(gp) : null;
    const date = roundDate(s, t.id);
    return `<article class="cal-card ${state}" style="--team:${esc(state === 'done' ? f1Colour(((gp.results || [])[0] || {}).teamId) : 'var(--line)')}">
      <header><span class="cal-round">Round ${esc(t.round)}</span>${state === 'live' ? '<span class="tag live">On now</span>' : state === 'next' ? '<span class="tag open">Next</span>' : state === 'done' ? '<span class="tag">Done</span>' : ''}</header>
      <h2>${esc(t.flag || '')} ${esc(t.name)}</h2>
      <p class="muted small">${esc(t.circuit || '')}. ${t.laps} laps${t.hasSprint ? ', with a sprint' : ''}.${date ? ` ${esc(fmtDay(date))}.` : ''}</p>
      ${edit ? `<label class="field small">Date<input type="date" data-bind="ui/form/calDates/${esc(t.id)}" value="${esc(df[t.id] != null ? df[t.id] : date)}"></label>` : ''}
      ${state === 'done' ? `<ol class="cal-podium">${podiumLine(gp)}</ol><p class="small muted">${pole ? `Pole: ${esc(pole.name)}. ` : ''}${dotd && !votingOpen(gp) ? `Driver of the Day: ${esc((F1.person(dotd.personId) || {}).name || '')}.` : ''}</p>` : ''}
      ${state === 'live' ? `<p class="small">${live.status === 'practice' ? 'Practice is running.' : live.status === 'quali' ? 'Qualifying is running.' : live.state && live.state.lap ? `Race: lap ${live.state.lap} of ${live.state.laps}.` : 'The grid is set.'}</p>` : ''}
      ${state === 'next' || state === 'later' ? `<p class="small muted">${esc(String(t.type || '').replace('-', ' ').replace(/^./, c => c.toUpperCase()))} circuit, ${Math.round((t.wr || 0) * 0.6)}% chance of rain. ${lastTimeHere(s, t.id)}</p>` : ''}
      <div class="btn-row">${sprint ? `<button class="btn small" data-act="cal-open" data-id="${esc(sprint.id)}">Sprint</button>` : ''}${gp ? `<button class="btn small ${state === 'done' ? 'primary' : ''}" data-act="cal-open" data-id="${esc(gp.id)}">${gp.status === 'finished' ? 'What happened' : 'Go to the weekend'}</button>` : ''}</div>
    </article>`;
  }).join('');
  const testCards = tests.map(w => { const t = get('f1_tracks', w.trackId) || {};
    return `<article class="cal-card test ${w.status === 'finished' ? 'done' : 'live'}"><header><span class="cal-round">Testing</span>${w.status === 'finished' ? '<span class="tag">Done</span>' : '<span class="tag live">On now</span>'}</header>
      <h2>${esc(t.flag || '')} Pre-season testing</h2><p class="muted small">${esc(t.circuit || t.name || '')}. ${plural(endedSessions(w).length, 'day')} run.</p>
      <div class="btn-row"><button class="btn small ${w.status === 'finished' ? 'primary' : ''}" data-act="cal-open" data-id="${esc(w.id)}">${w.status === 'finished' ? 'See the timesheets' : 'Go to testing'}</button></div></article>`; }).join('');
  return `<div class="page-head"><div><p class="eyebrow">${esc(s.name)}, ${esc(season.name)} season</p><h1>Calendar</h1><p>${done} of ${plural(tracks.length, 'round')} done. Pick a round to see what happened.</p></div>
      <div class="btn-row"><button class="btn" data-act="share-open" data-kind="calendar">Export calendar</button><div class="seg" role="tablist" aria-label="Show">${[['all', 'All rounds'], ['done', 'Done'], ['tocome', 'To come']].map(([k, l]) => `<button role="tab" aria-selected="${filter === k}" data-act="cal-filter" data-f="${k}">${l}</button>`).join('')}</div>
      ${S.isGm ? (edit ? '<button class="btn primary" data-act="cal-dates-save">Save the dates</button><button class="btn" data-act="cal-edit">Cancel</button>' : '<button class="btn" data-act="cal-edit">Set dates</button>') : ''}</div></div>
    <div class="cal-grid">${typeof plannedTestsHtml === 'function' ? plannedTestsHtml(s, tests, filter) : (filter !== 'done' || tests.some(w => w.status === 'finished') ? testCards : '')}${cards || '<div class="empty">Nothing here yet.</div>'}</div>`;
});

/* =====================================================================
   F1 SIM — the race report.
   Everything that happened in a weekend, for writing it up: each
   practice (or testing) session with its conditions, incidents,
   timesheet and the players' runs; qualifying session by session; and
   the race lap by lap, with every car's position, gap, lap time, tyre and
   stops, the weather and every event. Three formats: .txt (readable),
   .json (complete data) and .csv (one row per car per lap, plus events).
   ===================================================================== */
'use strict';

const TRACK_WORD = ['dry', 'damp', 'wet'];
function entInfo(w) { const ents = w.entrants || f1Entrants(); return id => { const e = ents.find(x => x.id === id) || { id, name: id }; return { code: id, name: e.name || id, team: (get('f1_teams', e.teamId) || {}).name || '', player: !!e.charId }; }; }
function buildReport(w) {
  const t = get('f1_tracks', w.trackId) || {}, s = seriesDoc(wSeries(w)), who = entInfo(w), st = w.state;
  const rep = { league: 'F1 SIM', exported: stampText(), series: s.name, season: seasonDoc(wSeason(w)).name, round: (F1.track(w.trackId) || {}).round || null, event: t.name || w.trackId, circuit: t.circuit || '',
    session: w.session === 'test' ? 'Pre-season testing' : w.session === 'sprint' ? 'Sprint' : 'Grand Prix', official: raceSettings(w).lock !== false, practice: [], qualifying: null, race: null };
  /* Practice or testing. */
  endedSessions(w).forEach(sess => {
    const rows = exportRows(w, `fp${sess.n}`);
    const runs = list('f1_runs').filter(r => r.weekendId === w.id && (r.session || 1) === sess.n).sort((a, b) => String(a.at).localeCompare(String(b.at))).map(r => {
      const e = (w.entrants || f1Entrants()).find(x => x.id === r.carId), x = e ? f1RunResult(w, Object.assign({}, e, { v3: (f1Entrants().find(z => z.id === e.id) || {}).v3 }), r) : {};
      return { car: r.carId, by: (get('characters', r.charId) || {}).name || '', kind: r.kind === 'setup' ? 'Set-up run' : r.kind === 'long' ? 'Long run' : 'Qualifying simulation',
        dials: r.kind === 'setup' ? r.dials : undefined, tyre: r.kind === 'long' ? r.compound : undefined, lost: x.lost || undefined, conditions: x.cond || undefined,
        lap: x.lap ? f1Fmt(x.lap) : undefined, tyreLife: x.life || undefined, feedback: x.notes || undefined };
    });
    rep.practice.push({ name: sessionName(w, sess.n), conditions: sess.weather ? weatherText(sess.weather) : 'Dry throughout.', incidents: (sess.events || []).map(e => e.text),
      timesheet: rows.map(r => ({ pos: r.pos, code: r.code, driver: r.name, team: r.team, time: r.value })), runs });
  });
  /* Qualifying. */
  if (w.quali && w.quali.results) {
    const stages = exportStages(w).filter(x => /^q/.test(x[0]));
    rep.qualifying = { stages: stages.map(([k, label]) => ({ name: label, results: exportRows(w, k).map(r => ({ pos: r.pos, code: r.code, driver: r.name, team: r.team, time: r.value })) })),
      penalties: Object.keys(w.penalties || {}).map(id => `${id}: ${w.penalties[id].places}-place grid penalty, ${w.penalties[id].reason}`),
      grid: (w.quali.grid || []).map((id, i) => Object.assign({ pos: i + 1 }, who(id))) };
  }
  /* The race, lap by lap. */
  if (st && st.lap > 0) {
    const cars = st.cars, cum = {}, laps = [];
    cars.forEach(c => { cum[c.id] = ((c.grid || 1) - 1) * 0.25; });   /* the grid stagger the race starts from */
    const tyreAt = (c, L) => (c.stints || []).find(x => x.from <= L && (x.to == null || x.to >= L)) || {};
    for (let L = 1; L <= st.lap; L++) {
      cars.forEach(c => { if (c.lapTimes[L - 1] != null && (c.status === 'running' || (c.retiredLap || 999) >= L)) cum[c.id] += c.lapTimes[L - 1]; });
      const running = cars.filter(c => c.positions[L - 1] != null).sort((a, b) => a.positions[L - 1] - b.positions[L - 1]), lead = running[0];
      laps.push({ lap: L, track: TRACK_WORD[st.track[L - 1] || 0], events: st.events.filter(e => e.lap === L).map(e => e.text),
        order: running.map(c => { const out = c.status !== 'running' && c.retiredLap != null && c.retiredLap < L, ty = tyreAt(c, L), stint = (c.stints || []).indexOf(ty);
          return { pos: c.positions[L - 1], code: c.id, driver: who(c.id).name, team: who(c.id).team, status: out ? 'out' : 'running',
            lapTime: out ? null : (c.lapTimes[L - 1] != null ? f1Fmt(c.lapTimes[L - 1]) : null), gap: out ? null : c === lead ? 0 : Math.round((cum[c.id] - cum[lead.id]) * 10) / 10,
            tyre: ty.compound || null, tyreAge: ty.from ? L - ty.from + 1 : null, pitted: !!(ty.to === L && stint < c.stints.length - 1) }; }) });
    }
    rep.race = { laps: st.laps, lapsRun: st.lap, finished: !!st.finished, lapsByLap: laps,
      result: (w.results || []).map(r => ({ pos: r.position || null, code: r.id, driver: r.name, team: (get('f1_teams', r.teamId) || {}).name || '', grid: r.grid, stops: r.stops, time: r.position === 1 ? fmtRaceTime(r.time || 0) : (r.gap || ''), points: r.points || 0, status: r.position ? 'finished' : (r.gap || 'out') })) };
  }
  return rep;
}
function reportTxt(rep) {
  const L = [], line = (s = '') => L.push(s), hr = () => line('-'.repeat(72));
  line(`${rep.league}: ${rep.series}, ${rep.season} season`); line(`Exported ${rep.exported}`); line(`${rep.round ? `Round ${rep.round}: ` : ''}${rep.event}${rep.session === 'Grand Prix' ? '' : ', ' + rep.session.toLowerCase()}`); line(rep.circuit); hr();
  rep.practice.forEach(p => { line(); line(p.name.toUpperCase() === p.name ? p.name : p.name); line(`Conditions: ${p.conditions}`);
    if (p.incidents.length) { line('Incidents:'); p.incidents.forEach(i => line(`  - ${i}`)); }
    line('Timesheet:'); p.timesheet.forEach(r => line(`  ${String(r.pos).padStart(2)}. ${r.code.padEnd(4)} ${r.driver.padEnd(22)} ${r.team.padEnd(16)} ${r.time}`));
    if (p.runs.length) { line('Players’ runs:'); p.runs.forEach(r => { line(`  ${r.car} (${r.by}): ${r.kind}${r.dials ? ` with downforce ${r.dials.wing}, suspension ${r.dials.susp}, differential ${r.dials.diff}` : ''}${r.tyre ? ` on ${r.tyre}s` : ''}.${r.lost ? ' Lost: ' + r.lost : ''}${r.lap ? ` ${r.lap}` : ''}${r.tyreLife ? `, tyres last about ${r.tyreLife} laps` : ''}${r.conditions && r.conditions !== 'dry' ? ` (${r.conditions} track)` : ''}`); (r.feedback || []).forEach(f => line(`      ${f}`)); }); }
    hr(); });
  if (rep.qualifying) { line(); line('QUALIFYING'); rep.qualifying.stages.forEach(q => { line(q.name + ':'); q.results.forEach(r => line(`  ${String(r.pos).padStart(2)}. ${r.code.padEnd(4)} ${r.driver.padEnd(22)} ${r.team.padEnd(16)} ${r.time}`)); });
    if (rep.qualifying.penalties.length) { line('Penalties:'); rep.qualifying.penalties.forEach(p => line(`  - ${p}`)); }
    line('Starting grid: ' + rep.qualifying.grid.map(g => `${g.pos} ${g.code}`).join(', ')); hr(); }
  if (rep.race) { line(); line(`THE RACE: ${rep.race.lapsRun} of ${rep.race.laps} laps${rep.race.finished ? '' : ' (still running)'}`);
    rep.race.lapsByLap.forEach(l => { line(); line(`Lap ${l.lap} (${l.track} track)`);
      l.events.forEach(e => line(`  * ${e}`));
      line('  ' + l.order.map(o => o.status === 'out' ? `${o.code} out` : `${o.pos}. ${o.code}${o.pos === 1 ? '' : ' +' + o.gap}${o.pitted ? ' (pitted)' : ''}`).join(' | '));
      line('  Laps and tyres: ' + l.order.filter(o => o.status !== 'out').map(o => `${o.code} ${o.lapTime || ''} ${o.tyre ? o.tyre.charAt(0).toUpperCase() + o.tyreAge : ''}`).join(', ')); });
    if (rep.race.result.length) { hr(); line('RESULT'); rep.race.result.forEach(r => line(`  ${r.pos ? String(r.pos).padStart(2) + '.' : 'Out'} ${r.code.padEnd(4)} ${r.driver.padEnd(22)} ${r.team.padEnd(16)} ${r.time.padEnd(12)} from P${r.grid}, ${plural(r.stops || 0, 'stop')}${r.points ? `, ${r.points} pts` : ''}`)); } }
  return L.join('\n') + '\n';
}
const csvCell = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
function reportCsv(rep) {
  const rows = [['stage', 'session', 'lap', 'position', 'code', 'driver', 'team', 'time', 'gap_to_leader', 'tyre', 'tyre_age', 'pitted', 'status', 'note']];
  rep.practice.forEach(p => { p.timesheet.forEach(r => rows.push(['practice', p.name, '', r.pos, r.code, r.driver, r.team, r.time, '', '', '', '', '', ''])); p.incidents.forEach(i => rows.push(['practice', p.name, '', '', '', '', '', '', '', '', '', '', '', i]));
    p.runs.forEach(r => rows.push(['practice run', p.name, '', '', r.car, r.by, '', r.lap || '', '', r.tyre || '', '', '', r.lost ? 'lost' : '', `${r.kind}${r.dials ? ` ${r.dials.wing}/${r.dials.susp}/${r.dials.diff}` : ''}${r.lost ? ': ' + r.lost : ''}${r.tyreLife ? `: tyres about ${r.tyreLife} laps` : ''}`])); });
  if (rep.qualifying) rep.qualifying.stages.forEach(q => q.results.forEach(r => rows.push(['qualifying', q.name, '', r.pos, r.code, r.driver, r.team, r.time, '', '', '', '', '', ''])));
  if (rep.race) { rep.race.lapsByLap.forEach(l => { l.order.forEach(o => rows.push(['race', '', l.lap, o.pos, o.code, o.driver, o.team, o.lapTime || '', o.gap == null ? '' : o.gap, o.tyre || '', o.tyreAge || '', o.pitted ? 'yes' : '', o.status, l.track]));
      l.events.forEach(e => rows.push(['race event', '', l.lap, '', '', '', '', '', '', '', '', '', '', e])); });
    rep.race.result.forEach(r => rows.push(['result', '', '', r.pos || '', r.code, r.driver, r.team, r.time, '', '', '', '', r.status, `from P${r.grid}, ${r.stops} stops, ${r.points} pts`])); }
  return rows.map(r => r.map(csvCell).join(',')).join('\n') + '\n';
}
ACTIONS['rep-download'] = d => {
  const w = get('f1_weekends', d.id); if (!w) return;
  const rep = buildReport(w), fmt = d.fmt, base = `${w.trackId}-${w.session}-${seasonDoc(wSeason(w)).name}-report`;
  const body = fmt === 'json' ? JSON.stringify(rep, null, 2) : fmt === 'csv' ? reportCsv(rep) : reportTxt(rep);
  const blob = new Blob([body], { type: fmt === 'json' ? 'application/json' : fmt === 'csv' ? 'text/csv' : 'text/plain' }), url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = `${base}.${fmt}`; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
  toast(`Race report saved as ${base}.${fmt}.`);
};
ACTIONS['rep-open'] = d => { S.ui.rep = { wid: d.id }; openDrawer('rep'); };
DRAWERS.rep = function () {
  const w = get('f1_weekends', (S.ui.rep || {}).wid); if (!w) return '';
  const t = get('f1_tracks', w.trackId) || {}, rep = buildReport(w);
  return `<header><div><h2>Race report</h2><p>${esc(t.name || '')}${w.session === 'sprint' ? ' sprint' : w.session === 'test' ? ' testing' : ''}: everything that happened, for writing it up.</p></div><button class="btn ghost" data-act="close-drawer">Close</button></header>
    <div class="body"><p>It covers ${[rep.practice.length ? `${plural(rep.practice.length, w.session === 'test' ? 'test day' : 'practice session')} (conditions, incidents, timesheets and the players’ runs)` : '', rep.qualifying ? 'qualifying, session by session' : '', rep.race ? `the race lap by lap, ${rep.race.lapsRun} of ${rep.race.laps} laps (positions, gaps, lap times, tyres, stops, weather and every event)` : ''].filter(Boolean).join('; ') || 'nothing yet'}.</p>
    <div class="rep-formats">
      <button class="btn" data-act="rep-download" data-id="${esc(w.id)}" data-fmt="txt"><b>Text (.txt)</b><span>A readable account, stage by stage and lap by lap.</span></button>
      <button class="btn" data-act="rep-download" data-id="${esc(w.id)}" data-fmt="json"><b>JSON (.json)</b><span>The complete data, for tools and bots.</span></button>
      <button class="btn" data-act="rep-download" data-id="${esc(w.id)}" data-fmt="csv"><b>Spreadsheet (.csv)</b><span>One row per car per lap, plus every event.</span></button>
    </div></div>`;
};
/* The report button sits beside Export timing. */
const _exportBtnRep = exportButtonHtml;
exportButtonHtml = function (w) {
  const a = _exportBtnRep(w), has = w && (endedSessions(w).length || (w.quali && w.quali.results) || (w.state && w.state.lap > 0));
  return (a || '') + (has ? `<button class="btn small" data-act="rep-open" data-id="${esc(w.id)}">Race report</button>` : '');
};
/* On a finished weekend: practice and qualifying as well as the race. */
function weekendStoryHtml(w) {
  const done = endedSessions(w), q = w.quali && w.quali.results ? exportStages(w).filter(x => /^q/.test(x[0])) : [];
  if (!done.length && !q.length) return '';
  return `<section class="card"><h2>The rest of the weekend</h2>
    ${done.map(s => `<details><summary><b>${esc(sessionName(w, s.n))}</b>${s.weather ? ` <span class="muted small">${esc(weatherText(s.weather))}</span>` : ''}</summary><div class="scroll-x">${timesheetHtml(w, s)}</div></details>`).join('')}
    ${q.map(([k, label]) => { const rows = exportRows(w, k); return `<details><summary><b>${esc(label)}</b></summary><table class="data compact"><tbody>${rows.map(r => `<tr><td>${r.pos}</td><td><span class="f1-bar" style="background:${esc(r.color)}"></span>${esc(r.name)}</td><td class="num">${esc(r.value)}</td></tr>`).join('')}</tbody></table></details>`; }).join('')}</section>`;
}

/* =====================================================================
   F1 SIM — engines: the era for each season, and the makers.
   Race Control picks a season's engine era: today's 2026 hybrids, the
   2014 to 2025 hybrids, V8s, V10s, V12s, a non-hybrid V6 turbo (as in F2
   and F3) or fully electric. The era changes how races run: lap times,
   how much power matters, the battery and its boost (or none), fuel
   weight, tyre wear, reliability and the power-unit allowance.
   Each engine maker has ratings for power, reliability, efficiency and
   driveability, which feed every car using its engine. A new era
   reshuffles them; Race Control can set them by hand, and move a team to
   another maker for the season.
   ===================================================================== */
'use strict';

const ENGINE_FORMULAS = {
  hybrid26: { label: 'V6 turbo hybrid, 2026 rules', short: 'V6 hybrid', blurb: 'Half the power is electric: how the battery is used wins and loses races.', lap: 0, power: 1, fail: 1, fuel: 3.2, tyre: 1, pu: 4, boost: { cost: 35, bonus: 0.07 }, modeEnergy: null, empty: 0, noHybrid: false, eff: 0.012 },
  hybrid14: { label: 'V6 turbo hybrid, 2014 to 2025', short: 'V6 hybrid', blurb: 'Quicker cars, a smaller electric share, and a cheaper, stronger overtaking boost.', lap: -1.0, power: 1, fail: 1, fuel: 3.0, tyre: 1, pu: 4, boost: { cost: 25, bonus: 0.09 }, modeEnergy: { push: 6, standard: 15, manage: 24 }, empty: 0, noHybrid: false, eff: 0.01 },
  v8: { label: 'V8, 2.4 litres (2006 to 2013)', short: 'V8', blurb: 'Light, screaming and very reliable, with a small battery boost.', lap: -0.7, power: 1.1, fail: 0.7, fuel: 2.6, tyre: 0.92, pu: 8, boost: { cost: 20, bonus: 0.05 }, modeEnergy: { push: 14, standard: 20, manage: 26 }, empty: 0, noHybrid: false, eff: 0.005 },
  v10: { label: 'V10, 3.0 litres', short: 'V10', blurb: 'No hybrid and no boost: raw power matters more, they drink fuel, eat tyres and blow up more often.', lap: -1.2, power: 1.3, fail: 1.5, fuel: 3.6, tyre: 1.1, pu: null, boost: null, modeEnergy: null, empty: 0, noHybrid: true, eff: 0.004 },
  v12: { label: 'V12, 3.5 litres', short: 'V12', blurb: 'Brutal power, thirsty and fragile. No hybrid.', lap: -0.5, power: 1.45, fail: 2.0, fuel: 4.2, tyre: 1.15, pu: null, boost: null, modeEnergy: null, empty: 0, noHybrid: true, eff: 0.006 },
  v6turbo: { label: 'V6 turbo, no hybrid', short: 'V6 turbo', blurb: 'Simple and robust, as in Formula 2 and Formula 3. No battery or boost.', lap: 0, power: 1, fail: 0.9, fuel: 3.0, tyre: 1, pu: null, boost: null, modeEnergy: null, empty: 0, noHybrid: true, eff: 0.004 },
  electric: { label: 'Fully electric', short: 'electric', blurb: 'No fuel weight, but the battery drains as you push. Run it flat and you crawl.', lap: 4.0, power: 0.9, fail: 0.8, fuel: 0, tyre: 0.85, pu: 4, boost: { cost: 20, bonus: 0.06 }, modeEnergy: { push: -9, standard: -3, manage: 5 }, empty: 1.2, noHybrid: false, eff: 0.03 }
};
const ENGINE_ORDER = ['hybrid26', 'hybrid14', 'v8', 'v10', 'v12', 'v6turbo', 'electric'];
const ENGINE_STATS = [['power', 'Power'], ['reliability', 'Reliability'], ['efficiency', 'Efficiency'], ['driveability', 'Driveability']];
const MAKER_2026 = { Mercedes: [90, 88, 88, 86], Ferrari: [89, 85, 86, 87], Honda: [88, 87, 87, 85], 'Red Bull Ford': [87, 83, 88, 86], Audi: [85, 82, 85, 84] };

/* A season's engine set-up: stored on the season, else the series' usual. */
function engineConfig(seriesId, seasonId) {
  const sid = seriesId || curSeriesId(), sea = seasonId || curSeasonId(sid), doc = get('f1_seasons', sea), s = seriesDoc(sid);
  const e = (doc && doc.engine) || {};
  return { formula: ENGINE_FORMULAS[e.formula] ? e.formula : (s.development ? 'hybrid26' : 'v6turbo'), ratings: e.ratings || {}, teams: e.teams || {}, seed: e.seed || 0 };
}
const engineFormula = (sid, sea) => ENGINE_FORMULAS[engineConfig(sid, sea).formula];
function supplierOf(teamId, cfg) { const c = cfg || engineConfig(((get('f1_teams', teamId) || {}).seriesId) || 'f1'); return c.teams[teamId] || (get('f1_teams', teamId) || {}).powerUnit || 'Customer'; }
function makersOf(sid) { const ids = new Set(list('f1_teams').filter(t => (t.seriesId || 'f1') === sid).map(t => supplierOf(t.id, engineConfig(sid)))); return [...ids].sort(); }
/* A maker's ratings: Race Control's, else for the 2026 hybrids today's order, else a fresh order for the era. */
function makerRatings(name, sid, sea) {
  const c = engineConfig(sid, sea);
  if (c.ratings[name]) return Object.assign({ power: 85, reliability: 85, efficiency: 85, driveability: 85 }, c.ratings[name]);
  if (c.formula === 'hybrid26' && MAKER_2026[name]) { const v = MAKER_2026[name]; return { power: v[0], reliability: v[1], efficiency: v[2], driveability: v[3] }; }
  const r = RaceEngine.rng(h32('engine', c.formula, name, c.seed, sea || '')), n = () => 80 + Math.floor(r() * 13);
  return { power: n(), reliability: n(), efficiency: n(), driveability: n() };
}
function engineLabel(teamId) {
  const t = get('f1_teams', teamId) || {}, sid = t.seriesId || 'f1', f = engineFormula(sid), name = supplierOf(teamId, engineConfig(sid));
  return /spec|\(/i.test(name) ? `${name.replace(/\s*\(spec\)/i, '')} ${f.short}, spec` : `${name} ${f.short}`;
}
/* The engine's effect on a car's base numbers (used by every session and Team HQ). */
function engineApply(team, out) {
  const sid = team.seriesId || 'f1', f = engineFormula(sid), m = makerRatings(supplierOf(team.id, engineConfig(sid)), sid);
  out.topSpeed = Math.round(((out.topSpeed || 0) + (m.power - 85) * 0.12 * f.power) * 100) / 100;
  out.carPace = Math.round(((out.carPace || 0) + (m.power - 85) * 0.06 * f.power) * 100) / 100;
  out.reliability = Math.round(((out.reliability || 0) + (m.reliability - 85) * 0.6) * 100) / 100;
  out.tyreLife = Math.round(((out.tyreLife || 0) + (m.driveability - 85) * 0.3) * 100) / 100;
  return out;
}
/* Efficiency: how well the battery and fuel are used, worth more in hybrid and electric eras. */
function engineEfficiency(entrants, entries, w) {
  const sid = wSeries(w), sea = wSeason(w), f = engineFormula(sid, sea), cfg = engineConfig(sid, sea);
  entrants.forEach(e => { const en = entries.find(x => x.id === e.id); if (!en) return; const m = makerRatings(supplierOf(e.teamId, cfg), sid, sea);
    en.paceAdj = (en.paceAdj || 0) - (m.efficiency - 85) * f.eff; });
}
/* The race rules for the era. */
function engineRaceSetup(w, circuit, rules) {
  const f = engineFormula(wSeries(w), wSeason(w));
  circuit.baseLap = (circuit.baseLap || 90) + f.lap;
  circuit.weights = Object.assign({}, circuit.weights || { power: 1, aero: 1, grip: 1 }); circuit.weights.power = (circuit.weights.power || 0) * f.power;
  circuit.tyreStress = (circuit.tyreStress || 1) * f.tyre;
  rules.fuelEffect = f.fuel; rules.failureRate = (rules.failureRate || RaceEngine.DEFAULTS.failureRate) * f.fail;
  rules.noHybrid = !!f.noHybrid; rules.modeEnergy = f.modeEnergy; rules.emptyBattery = f.empty;
  if (f.boost) rules.overtakeMode = Object.assign({}, RaceEngine.DEFAULTS.overtakeMode, f.boost);
  return { circuit, rules };
}

/* ---------------------------------------------------------------- Race Control: the season's engine rules */
async function saveEngine(patch, msg) {
  const sea = curSeasonId(), cur = get('f1_seasons', sea) ? clone(S.store.f1_seasons[sea]) : Object.assign({}, seasonDoc(sea)); delete cur.implicit;
  cur.engine = Object.assign({}, engineConfig(), cur.engine || {}, patch);
  return run(async () => { await Data.put('f1_seasons', sea, cur); await Data.audit('season.engine', msg); }, msg);
}
CHANGES['engine-formula'] = v => {
  if (!ENGINE_FORMULAS[v]) return; const done = finishedGps().length;
  const go2 = () => saveEngine({ formula: v, ratings: {} }, `Engines for ${curSeason().name}: ${ENGINE_FORMULAS[v].label}.`);
  if (done) askConfirm(`${plural(done, 'Grand Prix', 'Grands Prix')} of this season have been run. Change the engines for the rest of it?`, 'Change the engines', go2, true); else go2();
};
ACTIONS['engine-reshuffle'] = () => askConfirm('Give every engine maker a fresh set of ratings for this era?', 'Reshuffle the makers', () => saveEngine({ ratings: {}, seed: (engineConfig().seed || 0) + 1 }, 'Engine makers reshuffled.'));
ACTIONS['engine-save'] = () => {
  const f = S.ui.form.eng || {}, ratings = {}, teams = Object.assign({}, engineConfig().teams);
  Object.keys(f.r || {}).forEach(name => { ratings[name] = Object.assign(makerRatings(name), ...Object.keys(f.r[name]).map(k => ({ [k]: Math.max(50, Math.min(99, Number(f.r[name][k]) || 85)) }))); });
  Object.keys(f.t || {}).forEach(tid => { if (f.t[tid]) teams[tid] = f.t[tid]; });
  saveEngine({ ratings: Object.assign({}, engineConfig().ratings, ratings), teams }, 'Engine rules saved.').then(() => { S.ui.form.eng = null; });
};
function engineCardHtml() {
  const s = curSeries(), cfg = engineConfig(), f = ENGINE_FORMULAS[cfg.formula], makers = makersOf(s.id), rc = S.isGm && curSeason().status !== 'archived';
  const ef = S.ui.form.eng = S.ui.form.eng || { r: {}, t: {} };
  const teams = F1.teams();
  return `<section class="card engine-card"><h2>Engines</h2>
    <p><b>${esc(f.label)}.</b> ${esc(f.blurb)}</p>
    <p class="muted small">${f.noHybrid ? 'No battery or boost.' : f.modeEnergy && f.modeEnergy.standard < 0 ? 'The battery drains as cars race; a flat battery costs over a second a lap.' : 'Battery boost for overtaking.'} ${f.pu ? `${f.pu} power units per car for the season.` : 'No power-unit limit.'} ${f.lap < 0 ? `Laps about ${Math.abs(f.lap).toFixed(1)}s quicker than today’s cars.` : f.lap > 0 ? `Laps about ${f.lap.toFixed(1)}s slower than today’s cars.` : ''}</p>
    ${rc ? `<label class="field" style="max-width:420px">Engine era for ${esc(curSeason().name)}<select id="eng-formula" data-change="engine-formula">${ENGINE_ORDER.map(k => `<option value="${k}" ${cfg.formula === k ? 'selected' : ''}>${esc(ENGINE_FORMULAS[k].label)}</option>`).join('')}</select></label>` : ''}
    <h3>The makers</h3>
    <div class="scroll-x"><table class="data compact"><thead><tr><th>Maker</th><th>Teams</th>${ENGINE_STATS.map(([, l]) => `<th class="num">${l}</th>`).join('')}</tr></thead><tbody>
      ${makers.map(name => { const m = makerRatings(name), users = teams.filter(t => supplierOf(t.id, cfg) === name).map(t => t.name).join(', ');
        return `<tr><td><b>${esc(name)}</b></td><td class="small">${esc(users)}</td>${ENGINE_STATS.map(([k, l]) => `<td class="num">${rc ? `<label class="sr-only" for="eng-${esc(name)}-${k}">${esc(name)} ${l}</label><input id="eng-${esc(name)}-${k}" type="number" min="50" max="99" value="${esc(((ef.r[name] || {})[k]) != null ? ef.r[name][k] : m[k])}" data-bind="ui/form/eng/r/${esc(name)}/${k}" data-type="number" class="eng-num">` : `<b>${m[k]}</b>`}</td>`).join('')}</tr>`; }).join('')}</tbody></table></div>
    <p class="muted small">Power adds top speed and pace (more so in the V10 and V12 eras); reliability cuts failures; efficiency is worth lap time in hybrid and electric eras; driveability is kinder to tyres.</p>
    ${rc ? `<details><summary>Move a team to another maker</summary><div class="form-grid">${teams.map(t => `<label class="field small">${esc(t.name)}<select data-bind="ui/form/eng/t/${esc(t.id)}">${makers.concat(['Mercedes', 'Ferrari', 'Honda', 'Red Bull Ford', 'Audi'].filter(x => makers.indexOf(x) === -1 && s.development)).map(n => `<option ${((ef.t[t.id]) || supplierOf(t.id, cfg)) === n ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></label>`).join('')}</div></details>
      <div class="btn-row"><button class="btn primary" data-act="engine-save">Save the engine rules</button><button class="btn" data-act="engine-reshuffle">Reshuffle the makers</button></div>` : ''}</section>`;
}

/* =====================================================================
   F1 SIM — calendar and championship exports.
   Images for Discord in the Carbon look (or light): the season's
   calendar (every round, dates, winners, what's next), the drivers'
   championship (top three as cards, the rest below), the constructors'
   championship (points as bars in team colours), or both championships
   side by side (widescreen). Anyone can download; Race Control can post
   to Discord (DISCORD_WEBHOOK_CALENDAR / DISCORD_WEBHOOK_STANDINGS,
   falling back to the default channel).
   ===================================================================== */
'use strict';

const SHARE_KINDS = [['calendar', 'Calendar'], ['drivers', 'Drivers’ championship'], ['teams', 'Constructors’ championship'], ['both', 'Both championships (widescreen)']];
const slantBar = (g, x, y, w, h, col) => { g.fillStyle = col; g.beginPath(); g.moveTo(x + h, y); g.lineTo(x + w, y); g.lineTo(x + w - h, y + h); g.lineTo(x, y + h); g.closePath(); g.fill(); };
const codeOf = d => (F1.person(d.personId) || {}).abbr || initials(d.name);
function roundsDone() { return F1.weekends().filter(w => w.status === 'finished' && w.session === 'gp').length; }
function shareHeader(g, W, T, logo, title, sub) {
  drawMark(g, 60, 56, T, logo);
  g.font = cond(600, 24); g.fillStyle = T.muted; g.textAlign = 'right'; g.fillText(curSeries().name, W - 60, 80); g.textAlign = 'left';
  g.fillStyle = T.ink; fitText(g, title, s => cond(700, s), 92, W - 120); g.fillText(title, 58, 200);
  slantBar(g, 62, 222, 90, 8, '#E10600');
  g.font = bodyF(500, 24); g.fillStyle = T.muted; g.fillText(sub, 60, 268);
}
function drawCalendar(g, W, H, T) {
  const s = curSeries(), tracks = F1.tracks(), ws = F1.weekends(), dates = s.dates || {};
  const gpOf = id => ws.find(w => w.trackId === id && w.session === 'gp'), live = id => ws.some(w => w.trackId === id && w.session !== 'test' && w.status !== 'finished');
  const nextId = (tracks.find(t => !(gpOf(t.id) && gpOf(t.id).status === 'finished') && !live(t.id)) || {}).id;
  const items = ws.filter(w => w.session === 'test').map(w => ({ test: true, w, t: get('f1_tracks', w.trackId) || {} })).concat(tracks.map(t => ({ t })));
  const per = Math.ceil(items.length / 2), top = 300, rh = Math.min(92, Math.floor((H - top - 70) / Math.max(1, per))), cw = (W - 120 - 24) / 2;
  items.forEach((it, i) => {
    const col = i < per ? 0 : 1, x = 60 + col * (cw + 24), y = top + (i % per) * rh, h = rh - 8, t = it.t;
    const gp = !it.test && gpOf(t.id), done = it.test ? it.w.status === 'finished' : gp && gp.status === 'finished', isLive = it.test ? it.w.status !== 'finished' : live(t.id), isNext = !it.test && t.id === nextId;
    const win = done && !it.test ? (gp.results || [])[0] : null;
    rr(g, x, y, cw, h, 4); g.fillStyle = isNext ? (T.bg === '#E6E9EC' ? '#FDECEC' : '#3A1D20') : T.panel; g.fill();
    g.fillStyle = win ? f1Colour(win.teamId) : isNext || isLive ? '#E10600' : T.line; g.fillRect(x, y, 6, h);
    const fs = Math.min(28, Math.round(h * 0.34));
    g.font = cond(700, Math.round(fs * 0.7)); g.fillStyle = T.muted; g.fillText(it.test ? 'Testing' : `R${t.round}`, x + 20, y + h * 0.42);
    const nameX = x + 20 + (it.test ? 96 : 52);
    g.fillStyle = done ? T.muted : T.ink; g.font = cond(700, fs); const nm = `${t.flag || ''} ${it.test ? 'Pre-season testing' : t.name}`; fitText(g, nm, z => cond(700, z), fs, cw - (nameX - x) - 120); g.fillText(nm, nameX, y + h * 0.44);
    const date = it.test ? '' : dates[t.id] ? fmtDay(dates[t.id]) : '';
    g.font = bodyF(600, Math.round(fs * 0.62)); g.textAlign = 'right'; g.fillStyle = T.muted; if (date) g.fillText(date, x + cw - 16, y + h * 0.42);
    let line2 = '', c2 = T.muted;
    if (win) { line2 = `Winner: ${win.name}`; c2 = T.ink; } else if (isLive) { line2 = 'On now'; c2 = T.bg === '#E6E9EC' ? '#B80500' : '#FF6B63'; } else if (isNext) { line2 = 'Next'; c2 = T.bg === '#E6E9EC' ? '#B80500' : '#FF6B63'; } else if (done && it.test) line2 = 'Done';
    g.textAlign = 'left'; g.font = bodyF(600, Math.round(fs * 0.62)); g.fillStyle = c2; g.fillText(line2 || (t.circuit || ''), nameX, y + h * 0.8);
    if (!it.test && t.hasSprint && s.id === 'f1') { g.textAlign = 'right'; g.fillStyle = T.muted; g.font = bodyF(600, Math.round(fs * 0.55)); g.fillText('Sprint', x + cw - 16, y + h * 0.8); g.textAlign = 'left'; }
  });
}
async function drawDrivers(g, W, H, T, rows, top3imgs) {
  const lead = rows[0] ? rows[0].pts : 0, colW = (W - 120 - 36) / 3, cy = 300, ch = 330;
  rows.slice(0, 3).forEach((d, i) => { const x = 60 + i * (colW + 18);
    rr(g, x, cy, colW, ch, 6); g.fillStyle = T.panel; g.fill(); g.fillStyle = f1Colour(d.teamId); g.fillRect(x, cy, colW, 8);
    drawPhoto(g, top3imgs[i], x + 14, cy + 22, 110, 130, 6, d, T);
    g.fillStyle = i === 0 ? '#E10600' : T.muted; g.font = cond(700, 96); g.textAlign = 'right'; g.fillText(`P${i + 1}`, x + colW - 14, cy + 112); g.textAlign = 'left';
    g.fillStyle = T.ink; fitText(g, d.name, z => cond(700, z), 32, colW - 28); g.fillText(d.name, x + 14, cy + 196);
    g.font = bodyF(500, 18); g.fillStyle = T.muted; g.fillText(F1.team(d.teamId).name || '', x + 14, cy + 224);
    g.fillStyle = T.ink; g.font = cond(700, 64); g.fillText(String(d.pts), x + 14, cy + 300); const pw = g.measureText(String(d.pts)).width;
    g.font = bodyF(600, 20); g.fillStyle = T.muted; g.fillText(i ? `pts, −${lead - d.pts}` : 'pts', x + 22 + pw, cy + 300);
  });
  const rest = rows.slice(3), per = Math.ceil(rest.length / 2), rh = Math.min(40, Math.floor((H - 690 - 60) / Math.max(1, per))), cw = (W - 120 - 36) / 2;
  rest.forEach((d, k) => { const col = k < per ? 0 : 1, x = 60 + col * (cw + 36), y = 680 + (k % per) * rh, fs = Math.min(24, rh - 10);
    g.fillStyle = T.line; g.fillRect(x, y + rh - 1, cw, 1);
    g.fillStyle = T.muted; g.font = cond(700, fs); g.fillText(String(k + 4), x, y + rh - 11);
    g.fillStyle = f1Colour(d.teamId); g.fillRect(x + 42, y + 8, 6, rh - 16);
    g.fillStyle = T.ink; g.font = cond(700, fs); g.fillText(codeOf(d), x + 58, y + rh - 11);
    g.fillStyle = T.muted; g.font = bodyF(500, Math.min(18, rh - 14)); const nm = d.name.length > 18 ? d.name.slice(0, 17) + '…' : d.name; g.fillText(nm, x + 122, y + rh - 12);
    g.fillStyle = T.ink; g.font = cond(700, fs); g.textAlign = 'right'; g.fillText(`${d.pts}`, x + cw, y + rh - 11); g.textAlign = 'left'; });
}
function drawTeams(g, x0, y0, w, h, T, rows) {
  const lead = Math.max(1, rows[0] ? rows[0].pts : 1), rh = Math.min(84, Math.floor(h / Math.max(1, rows.length)));
  rows.forEach((t, i) => { const y = y0 + i * rh, team = F1.team(t.teamId), fs = Math.min(28, Math.round(rh * 0.36));
    g.fillStyle = i === 0 ? '#E10600' : T.muted; g.font = cond(700, fs + 4); g.fillText(String(i + 1), x0, y + rh * 0.62);
    const ny = y + rh * 0.36;
    g.fillStyle = T.ink; g.font = cond(700, fs); g.fillText(team.name || t.teamId, x0 + 52, ny);
    g.fillStyle = T.muted; g.font = bodyF(500, Math.round(fs * 0.6)); g.fillText(`${engineLabel(t.teamId)}${t.wins ? `, ${plural(t.wins, 'win')}` : ''}`, x0 + 52, ny + fs * 0.8);
    const bx = x0 + 52, bw = w - 52 - 110, bh = Math.max(6, Math.round(rh * 0.12)), by = ny + fs * 1.15;
    g.fillStyle = T.line; g.fillRect(bx, by, bw, bh); g.fillStyle = f1Colour(t.teamId); g.fillRect(bx, by, Math.max(2, bw * t.pts / lead), bh);
    g.fillStyle = T.ink; g.font = cond(700, fs + 6); g.textAlign = 'right'; g.fillText(String(t.pts), x0 + w, y + rh * 0.62); g.textAlign = 'left'; });
}
async function drawShare(kind, theme) {
  const T = EXP_THEMES[theme] || EXP_THEMES.dark, st = f1Standings(), done = roundsDone(), total = F1.tracks().length, season = curSeason();
  try { await Promise.all(['700 100px "Titillium Web"', '600 30px "Titillium Web"'].map(f => document.fonts.load(f))); } catch (e) { /* fall back */ }
  const logo = await loadImg(leagueLogo()), wide = kind === 'both', W = wide ? 1920 : 1080, H = wide ? 1080 : 1350, cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const g = cv.getContext('2d'); g.fillStyle = T.bg; g.fillRect(0, 0, W, H);
  const after = done ? `After ${done} of ${plural(total, 'round')}.` : 'Before the first round.';
  if (kind === 'calendar') { shareHeader(g, W, T, logo, `${season.name} calendar`, `${plural(total, 'round')}${done ? `, ${done} done` : ''}.`); drawCalendar(g, W, H, T); }
  else if (kind === 'drivers') { shareHeader(g, W, T, logo, 'Drivers’ championship', `${season.name} season. ${after}`);
    const imgs = await Promise.all(st.drivers.slice(0, 3).map(d => loadImg(d.charId ? (get('characters', d.charId) || {}).portraitUrl : null))); await drawDrivers(g, W, H, T, st.drivers, imgs); }
  else if (kind === 'teams') { shareHeader(g, W, T, logo, 'Constructors’ championship', `${season.name} season. ${after}`); drawTeams(g, 60, 310, W - 120, H - 310 - 60, T, st.teams); }
  else {
    drawMark(g, 56, 52, T, logo); g.fillStyle = T.ink; g.font = cond(700, 64); g.fillText(`${season.name} championship`, 56, 160); slantBar(g, 60, 180, 90, 8, '#E10600');
    g.font = bodyF(500, 24); g.fillStyle = T.muted; g.fillText(`${curSeries().name}. ${after}`, 56, 226);
    const lx = 56, lw = 860, top = 270, rh = Math.min(36, Math.floor((H - top - 50) / Math.max(1, st.drivers.length)));
    g.font = cond(700, 30); g.fillStyle = T.ink; g.fillText('Drivers', lx, top - 6); g.fillText('Constructors', 1000, top - 6);
    st.drivers.forEach((d, i) => { const y = top + 8 + i * rh, fs = Math.min(22, rh - 10);
      g.fillStyle = T.line; g.fillRect(lx, y + rh - 1, lw, 1); g.fillStyle = i === 0 ? '#E10600' : T.muted; g.font = cond(700, fs); g.fillText(String(i + 1), lx, y + rh - 10);
      g.fillStyle = f1Colour(d.teamId); g.fillRect(lx + 44, y + 7, 6, rh - 14); g.fillStyle = T.ink; g.font = cond(700, fs); g.fillText(d.name, lx + 62, y + rh - 10);
      g.fillStyle = T.muted; g.font = bodyF(500, Math.min(17, rh - 14)); g.fillText(F1.team(d.teamId).name || '', lx + 420, y + rh - 11);
      g.fillStyle = T.ink; g.font = cond(700, fs); g.textAlign = 'right'; g.fillText(String(d.pts), lx + lw, y + rh - 10); g.textAlign = 'left'; });
    drawTeams(g, 1000, top + 10, W - 1000 - 56, H - top - 60, T, st.teams);
  }
  g.fillStyle = T.muted; g.font = bodyF(500, 17); g.textAlign = 'right'; g.fillText(`Shared from F1 SIM, ${stampText()}`, W - 60, H - 30); g.textAlign = 'left';
  return new Promise(ok => cv.toBlob(ok, 'image/png'));
}

/* ---------------------------------------------------------------- the export panel */
ACTIONS['share-open'] = d => {
  if (d.kind !== 'calendar' && !f1Standings().drivers.length) { toast('No points yet: standings appear after the first race.', true); return; }
  S.ui.sh = { kind: d.kind, theme: 'dark', url: null, blob: null, channel: '' }; openDrawer('sh'); shRefresh();
  if (S.isGm) discordChannels().then(() => renderOverlay()).catch(() => {});
};
async function shRefresh() {
  const x = S.ui.sh; if (!x) return; const blob = await drawShare(x.kind, x.theme); if (S.ui.sh !== x) return;
  if (x.url) URL.revokeObjectURL(x.url); x.blob = blob; x.url = URL.createObjectURL(blob); renderOverlay();
}
CHANGES['sh-set'] = (v, d) => { const x = S.ui.sh; if (!x) return; x[d.field] = v; if (d.field === 'channel') { renderOverlay(); return; } x.url = null; x.posted = null; renderOverlay(); shRefresh(); };
const sharePurpose = k => k === 'calendar' ? 'calendar' : 'standings';
DRAWERS.sh = function () {
  const x = S.ui.sh || {}, opt = (field, l) => `<select id="sh-${field}" data-change="sh-set" data-field="${field}">${l.map(([k, t]) => `<option value="${k}" ${x[field] === k ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>`;
  return `<header><div><h2>Export</h2><p>${esc(curSeries().name)}, ${esc(curSeason().name)} season. Download it, or post it to Discord.</p></div><button class="btn ghost" data-act="close-drawer">Close</button></header>
    <div class="body"><div class="form-grid"><label class="field">What${opt('kind', SHARE_KINDS)}</label><label class="field">Look${opt('theme', [['dark', 'Carbon'], ['light', 'Light']])}</label>
      ${S.isGm ? `<label class="field">Discord channel${opt('channel', [['', `Automatic: #${S.discordCh ? pickChannel(sharePurpose(x.kind), curSeriesId(), S.discordCh) : '…'}`]].concat((S.discordCh || []).map(c => [c, '#' + c])))}</label>` : ''}</div>
    ${x.url ? `<img class="card-preview tx-preview" src="${x.url}" alt="The ${esc((SHARE_KINDS.find(k => k[0] === x.kind) || ['', ''])[1])} image">` : '<p class="muted">Drawing…</p>'}
    <div class="btn-row"><button class="btn primary" data-act="sh-download" ${x.url ? '' : 'disabled'}>Download</button>${S.isGm ? `<button class="btn" data-act="sh-discord" ${x.url ? '' : 'disabled'}>Post to Discord</button>` : ''}${x.posted ? `<span class="tag player">Posted to #${esc(x.posted)}</span>` : ''}</div></div>`;
};
ACTIONS['sh-download'] = () => { const x = S.ui.sh; if (!x || !x.url) return; const a = document.createElement('a'); a.href = x.url; a.download = `${curSeriesId()}-${curSeason().name}-${x.kind}.png`; document.body.appendChild(a); a.click(); a.remove(); };
ACTIONS['sh-discord'] = () => {
  const x = S.ui.sh; if (!x || !x.blob) return; const done = roundsDone(), s = curSeries(), sea = curSeason();
  const text = x.kind === 'calendar' ? `**${s.name}: the ${sea.name} calendar**` : `**${s.name} ${sea.name}: ${x.kind === 'teams' ? 'constructors’' : x.kind === 'drivers' ? 'drivers’' : 'the'} championship${done ? ` after round ${done}` : ''}**`;
  run(async () => { const ch = await discordSend(sharePurpose(x.kind), { content: text }, { blob: x.blob, name: `${s.id}-${sea.name}-${x.kind}.png` }, x.channel); x.posted = ch;
    await Data.audit('discord.share', `${text.replace(/\*/g, '')} posted to Discord #${ch}`); }, 'Posted to Discord.');
};

/* =====================================================================
   F1 SIM — race incidents: the reference list.
   Everything that can happen in a race, by family, with how often on the
   usual settings, and how Race Control's three settings scale them.
   ===================================================================== */
'use strict';

const INC_FAMILIES = [
  ['driver', 'Driver errors and crashes', 'Crashes, contact and driver errors', 'More in the rain, on lap 1 and at restarts, in push mode, and for aggressive or rattled drivers.'],
  ['contact', 'Contact between cars', 'Crashes, contact and driver errors', 'Happens when one car attacks another; more in the rain and on lap 1.'],
  ['pileup', 'Pile-ups', 'Crashes, contact and driver errors', 'At the start, and less often at restarts after a safety car; more in the rain.'],
  ['tyre', 'Tyres', 'Crashes, contact and driver errors', 'More at street circuits and on worn tyres.'],
  ['stewards', 'Stewards', 'Crashes, contact and driver errors', 'Penalties are served at the next stop, or added to the race time at the finish.'],
  ['mechanical', 'Mechanical', 'Mechanical failures and pit problems', 'More for less reliable cars and worn power units, and in the V10 and V12 eras; fewer with V8s.'],
  ['pit', 'Pit lane', 'Mechanical failures and pit problems', 'At each pit stop.'],
  ['external', 'Outside events', 'Outside events', 'Race-wide. Cloudbursts only when the weekend’s weather isn’t set to dry.']
];
const incRate = x => x.perRace != null ? (x.perRace >= 1 ? `About ${x.perRace.toFixed(1).replace('.0', '')} a race` : `1 race in ${Math.max(1, Math.round(1 / x.perRace))}`)
  : x.perStop != null ? `${(x.perStop * 100).toFixed(1).replace('.0', '')}% of stops` : `${Math.round(x.perStart * 100)}% of starts`;
ACTIONS['inc-open'] = () => openDrawer('incidents');
DRAWERS.incidents = function () {
  const list = RaceEngine.INCIDENTS || [];
  return `<header><div><h2>What can happen in a race</h2><p>How often each incident happens on the usual settings, in a dry race of about 55 laps with 22 cars. Race Control’s settings scale each group: none, fewer, as usual, more, or chaos.</p></div><button class="btn ghost" data-act="close-drawer">Close</button></header>
    <div class="body">${INC_FAMILIES.map(([fam, title, setting, note]) => { const xs = list.filter(x => x.family === fam); if (!xs.length) return '';
      return `<section class="inc-family"><h3>${esc(title)}</h3><p class="muted small">${esc(note)} Setting: <b>${esc(setting)}</b>.</p>
        <div class="scroll-x"><table class="data compact"><thead><tr><th>Incident</th><th>How often</th><th>What it does</th></tr></thead><tbody>${xs.map(x => `<tr><td><b>${esc(x.label)}</b></td><td class="nowrap">${esc(incRate(x))}</td><td class="small">${esc(x.effect)}</td></tr>`).join('')}</tbody></table></div></section>`; }).join('')}
      <section class="inc-family"><h3>Red flags</h3><p class="small">The race stops. The gaps close up, every car gets fresh tyres and repairs, and the race restarts behind the safety car. A storm in the last quarter ends the race there, and the results stand.</p></section></div>`;
};

/* =====================================================================
   F1 SIM — career records.
   A character's racing CV. On the application, players add seasons in
   other series (Formula 2 and 3, Formula 4, IndyCar, Super Formula,
   Formula E, WEC and Le Mans, IMSA, WRC, DTM and more). Each season waits
   for Race Control, who marks it canon or not canon; titles and wins in
   the top series are flagged as major achievements. Changes after
   approval go back for approval. The character page shows the canon
   record beside their F1 SIM seasons, which are worked out from results.
   ===================================================================== */
'use strict';

const CAREER_GROUPS = [
  ['Single-seaters', ['Formula 1', 'Formula 2', 'GP2 Series', 'Formula 3', 'GP3 Series', 'FIA F3 European Championship', 'F1 Academy', 'Formula Regional', 'Formula 4', 'Super Formula', 'Formula Nippon', 'Formula E', 'IndyCar', 'Indy NXT', 'Indy Lights', 'Karting']],
  ['Endurance', ['WEC', 'Le Mans 24 Hours', 'IMSA', 'European Le Mans Series', 'GT World Challenge']],
  ['Rally', ['WRC', 'WRC2', 'WRC3', 'Junior WRC', 'Production Car WRC', 'Super 2000 WRC', 'European Rally Championship', 'World Rallycross', 'Dakar']],
  ['Touring', ['DTM', 'BTCC', 'Supercars']],
  ['Other', ['Other']]
];
const MAJOR_SERIES = ['Formula 1', 'Formula 2', 'GP2 Series', 'IndyCar', 'Super Formula', 'Formula Nippon', 'Formula E', 'WEC', 'Le Mans 24 Hours', 'IMSA', 'WRC', 'WRC2', 'Production Car WRC', 'Super 2000 WRC'];
/* The years each series ran under that name, so a season outside them is flagged (with what it was called then). */
const SERIES_YEARS = {
  'Formula 1': [1950], 'Formula 2': [2017, null, 'FIA Formula 2 began in 2017; before that, use GP2 Series'], 'GP2 Series': [2005, 2016, 'GP2 ran from 2005 to 2016; from 2017 it is Formula 2'],
  'Formula 3': [2019, null, 'FIA Formula 3 began in 2019; before that, use GP3 Series or FIA F3 European Championship'], 'GP3 Series': [2010, 2018, 'GP3 ran from 2010 to 2018; from 2019 it is Formula 3'],
  'FIA F3 European Championship': [2012, 2018, 'the FIA F3 European Championship ran from 2012 to 2018'], 'F1 Academy': [2023, null, 'F1 Academy began in 2023'], 'Formula Regional': [2019, null, 'the Formula Regional European Championship began in 2019'],
  'Formula 4': [2014, null, 'FIA Formula 4 championships began in 2014'], 'Super Formula': [2013, null, 'Super Formula began in 2013; before that, use Formula Nippon'], 'Formula Nippon': [1996, 2012, 'Formula Nippon ran from 1996 to 2012; from 2013 it is Super Formula'],
  'Formula E': [2014, null, 'Formula E began in 2014'], 'IndyCar': [1996], 'Indy NXT': [2023, null, 'Indy NXT took that name in 2023; before that, use Indy Lights'], 'Indy Lights': [1986, 2022, 'Indy Lights ran until 2022; from 2023 it is Indy NXT'],
  'WEC': [2012, null, 'the World Endurance Championship began in 2012'], 'Le Mans 24 Hours': [1923], 'IMSA': [2014, null, 'the IMSA WeatherTech SportsCar Championship began in 2014'], 'European Le Mans Series': [2004, null, 'the European Le Mans Series began in 2004'],
  'WRC': [1973, null, 'the World Rally Championship began in 1973'], 'WRC2': [2013, null, 'WRC2 began in 2013; before that, use Production Car WRC or Super 2000 WRC'], 'WRC3': [2013, null, 'WRC3 began in 2013'],
  'Junior WRC': [2001], 'Production Car WRC': [1987, 2012, 'the Production Car WRC (the FIA Group N Cup until 2002) ran until 2012; from 2013 Group N cars went into WRC2'], 'Super 2000 WRC': [2010, 2012, 'the Super 2000 WRC ran from 2010 to 2012; from 2013 it is WRC2'],
  'European Rally Championship': [1953], 'World Rallycross': [2014, null, 'the FIA World Rallycross Championship began in 2014'], 'Dakar': [1979], 'DTM': [1984], 'BTCC': [1958], 'Supercars': [1997, null, 'known as V8 Supercars until 2016']
};
function seriesWarn(r) {
  const info = SERIES_YEARS[r && r.series]; if (!info) return '';
  const ys = String(r.years || '').match(/\b(19|20)\d{2}\b/g); if (!ys) return '';
  const lo = Math.min(...ys.map(Number)), hi = Math.max(...ys.map(Number));
  if ((info[0] && lo < info[0]) || (info[1] && hi > info[1])) return `Check the years: ${info[2] || `${r.series} ran ${info[0]}${info[1] ? ` to ${info[1]}` : ' onwards'}`}.`;
  return '';
}
const CAREER_POS = [['', 'Not given'], ['1', 'Champion'], ['2', '2nd'], ['3', '3rd'], ['4', '4th'], ['5', '5th'], ['6', '6th'], ['7', '7th'], ['8', '8th'], ['9', '9th'], ['10', '10th'], ['11', 'Lower than 10th'], ['0', 'Part season']];
const careerGroupOf = series => (CAREER_GROUPS.find(g => g[1].indexOf(series) !== -1) || ['Other'])[0];
const seriesLabel = r => r.series === 'Other' ? (r.other || 'Other') : r.series;
const posLabel = p => (CAREER_POS.find(x => x[0] === String(p)) || ['', ''])[1];
const isMajor = r => MAJOR_SERIES.indexOf(r.series) !== -1 && (String(r.pos) === '1' || Number(r.wins) > 0);
const CAREER_STATUS = { pending: ['Awaiting approval', 'open'], canon: ['Canon', 'player'], notcanon: ['Not canon', 'flag'] };

/* ---------------------------------------------------------------- the player's side */
/* The role someone had in a career season: wins, podiums and the championship are the team's (or their car's) results in a team role. */
const CAREER_ROLES = [['driver', 'Driver'], ['principal', 'Team principal'], ['director', 'Sporting director'], ['engineer', 'Race engineer'], ['strategist', 'Strategist'], ['consultant', 'Consultant'], ['other', 'Another team role']];
const CAREER_ROLE_KEYS = CAREER_ROLES.map(r => r[0]);
const careerRoleName = k => (CAREER_ROLES.find(r => r[0] === (k || 'driver')) || ['', 'Driver'])[1];
const roleGroupOf = k => ({ driver: 'driver', principal: 'principal', engineer: 'engineer' })[k || 'driver'] || 'other';
CHANGES['cr-role'] = v => { if (S.ui.form.cr) { S.ui.form.cr.role = v; render(); } };
const careerRows = c => (c && Array.isArray(c.career) ? c.career : []);
const careerEditable = c => !!c && (c.userId === S.uid || S.isGm) && !c.retired;
ACTIONS['cr-add'] = () => { const ch = get('characters', S.ui.charEdit) || {}; S.ui.form.cr = { id: null, role: ({ driver: 'driver', principal: 'principal', engineer: 'engineer' })[ch.role] || 'other', years: '', series: 'Formula 2', other: '', team: '', wins: '', podiums: '', poles: '', pos: '', notes: '' }; render(); };
ACTIONS['cr-edit'] = d => { const c = get('characters', S.ui.charEdit), r = careerRows(c).find(x => x.id === d.rid); if (r) { S.ui.form.cr = Object.assign({}, r); render(); } };
ACTIONS['cr-cancel'] = () => { S.ui.form.cr = null; render(); };
CHANGES['cr-series'] = v => { if (S.ui.form.cr) { S.ui.form.cr.series = v; render(); } };
const ordinal = n => { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };
ACTIONS['cr-save'] = () => {
  const c = get('characters', S.ui.charEdit), f = S.ui.form.cr; if (!c || !f || !careerEditable(c)) return;
  if (!String(f.years || '').trim()) { toast('Add the year or years, such as 2025 or 2023 to 2024.', true); return; }
  if (f.series === 'Other' && !String(f.other || '').trim()) { toast('Name the series.', true); return; }
  const num = v => v === '' || v == null ? '' : Math.max(0, Math.round(Number(v) || 0));
  const row = { id: f.id || newId('cr'), role: CAREER_ROLE_KEYS.indexOf(f.role) !== -1 ? f.role : 'driver', years: String(f.years).trim().slice(0, 20), series: f.series, other: f.series === 'Other' ? String(f.other).trim().slice(0, 60) : '',
    team: String(f.team || '').trim().slice(0, 60), wins: num(f.wins), podiums: num(f.podiums), poles: num(f.poles),
    pos: String(f.pos || ''), notes: String(f.notes || '').trim().slice(0, 200), status: 'pending', at: nowIso() };
  if (row.wins !== '' && row.podiums !== '' && row.wins > row.podiums) { toast('More wins than podiums: check the numbers.', true); return; }
  if (seriesWarn(row)) toast(seriesWarn(row) + ' Saved; Race Control will see the note.');
  const doc = charDoc(c.id), rows = careerRows(doc).filter(x => x.id !== row.id).concat([row]);
  rows.sort((a, b) => String(parseInt(a.years, 10) || 0).localeCompare(String(parseInt(b.years, 10) || 0)) || 0);
  doc.career = rows;
  run(async () => { await Data.put('characters', c.id, doc); S.ui.form.cr = null; }, charStatus(c) === 'approved' ? 'Saved. Race Control will check it before it becomes canon.' : 'Season added.');
};
ACTIONS['cr-remove'] = d => {
  const c = get('characters', S.ui.charEdit); if (!c || !careerEditable(c)) return;
  askConfirm('Remove this season from the career record?', 'Remove', () => run(async () => { const doc = charDoc(c.id); doc.career = careerRows(doc).filter(x => x.id !== d.rid); await Data.put('characters', c.id, doc); }, 'Removed.'), true);
};
function careerFormHtml(f) {
  const opt = (v, l, cur) => `<option value="${esc(v)}" ${String(cur) === String(v) ? 'selected' : ''}>${esc(l)}</option>`;
  const num = (k, l) => `<label class="field small">${l}<input id="cr-${k}" type="number" min="0" max="999" data-bind="ui/form/cr/${k}" value="${esc(f[k] === '' || f[k] == null ? '' : f[k])}"></label>`;
  return `<div class="career-form card"><h3>${f.id ? 'Edit this season' : 'Add a season'}</h3><div class="form-grid">
      <label class="field">Role<select id="cr-role" data-change="cr-role">${CAREER_ROLES.map(([v, l]) => opt(v, l, f.role || 'driver')).join('')}</select></label>
      <label class="field">Year or years<input id="cr-years" type="text" data-bind="ui/form/cr/years" value="${esc(f.years || '')}" placeholder="e.g. 2025, or 2023 to 2024"></label>
      <label class="field">Series<select id="cr-series" data-change="cr-series">${CAREER_GROUPS.map(([g, xs]) => `<optgroup label="${esc(g)}">${xs.map(x => opt(x, x === 'Other' ? 'Another series' : x, f.series)).join('')}</optgroup>`).join('')}</select></label>
      ${f.series === 'Other' ? `<label class="field">Which series<input id="cr-other" type="text" data-bind="ui/form/cr/other" value="${esc(f.other || '')}" placeholder="e.g. Super GT"></label>` : ''}
      <label class="field">Team<input id="cr-team" type="text" data-bind="ui/form/cr/team" value="${esc(f.team || '')}"></label>
      ${num('wins', 'Wins')}${num('podiums', 'Podiums')}${num('poles', /WRC|Dakar/.test(f.series) ? 'Stage wins' : 'Poles')}
      <label class="field">Championship<select id="cr-pos" data-bind="ui/form/cr/pos">${CAREER_POS.map(([v, l]) => opt(v, l, f.pos)).join('')}</select></label></div>
    <label class="field">Notes (optional)<input id="cr-notes" type="text" data-bind="ui/form/cr/notes" value="${esc(f.notes || '')}" placeholder="e.g. Class win at Le Mans; rookie of the year"></label>
    ${(f.role || 'driver') !== 'driver' ? '<p class="small"><b>In a team role, wins, podiums, poles and the championship are the team’s results that season</b> (for a race engineer, their car’s).</p>' : ''}
    <p class="muted small">Titles and wins in the top series count as major achievements: they only become canon once Race Control approves them.</p>
    <div class="btn-row"><button class="btn primary" data-act="cr-save">${f.id ? 'Save the season' : 'Add the season'}</button><button class="btn ghost" data-act="cr-cancel">Cancel</button></div></div>`;
}
/* The career record card on the application page. */
function careerAppHtml(c) {
  const rows = careerRows(c), can = careerEditable(c), f = S.ui.form.cr;
  return `<section class="card"><h2>Career record</h2>
    <p class="muted small">Seasons before F1 SIM, in any series: single-seaters, endurance, rally, touring and more. Each season waits for Race Control; only canon seasons show on the character page.</p>
    ${rows.length ? careerTableHtml(rows, { manage: can, review: false }) : '<p class="muted">No seasons added yet.</p>'}
    ${can ? (f ? careerFormHtml(f) : '<div class="btn-row"><button class="btn" data-act="cr-add">Add a season</button></div>') : ''}</section>`;
}
function careerTableHtml(rows, o) {
  const opts = o || {}, cell = v => v === '' || v == null ? '<span class="muted">–</span>' : esc(v);
  return `<div class="scroll-x"><table class="data compact career"><thead><tr><th>Years</th><th>Series</th><th>Team</th><th class="num">Wins</th><th class="num">Podiums</th><th class="num">Poles</th><th>Championship</th>${opts.status !== false ? '<th></th>' : ''}${opts.manage || opts.review ? '<th></th>' : ''}</tr></thead><tbody>
    ${rows.map(r => { const st = CAREER_STATUS[r.status || 'pending'] || CAREER_STATUS.pending;
      return `<tr><td>${esc(r.years)}</td><td><b>${esc(seriesLabel(r))}</b>${seriesWarn(r) ? `<div class="small warn-note">${esc(seriesWarn(r))}</div>` : ''}${r.notes ? `<div class="muted small">${esc(r.notes)}</div>` : ''}</td><td>${cell(r.team)}${(r.role || 'driver') !== 'driver' ? `<div class="muted small">${esc(careerRoleName(r.role))}</div>` : ''}</td>
        <td class="num">${cell(r.wins)}</td><td class="num">${cell(r.podiums)}</td><td class="num">${cell(r.poles)}</td><td>${String(r.pos) === '1' ? '<span class="tag trophy">Champion</span>' : r.pos ? esc(posLabel(r.pos)) : '<span class="muted">–</span>'}</td>
        ${opts.status !== false ? `<td>${isMajor(r) && r.status !== 'canon' ? '<span class="tag flag">Major achievement</span> ' : ''}<span class="tag ${st[1]}">${st[0]}</span></td>` : ''}
        ${opts.manage ? `<td class="nowrap"><button class="btn small" data-act="cr-edit" data-rid="${esc(r.id)}">Edit</button> <button class="btn small ghost" data-act="cr-remove" data-rid="${esc(r.id)}">Remove</button></td>` : ''}
        ${opts.review ? `<td class="nowrap"><button class="btn small ${r.status === 'canon' ? 'primary' : ''}" data-act="cr-judge" data-cid="${esc(opts.review)}" data-rid="${esc(r.id)}" data-v="canon" aria-pressed="${r.status === 'canon'}">Canon</button> <button class="btn small ${r.status === 'notcanon' ? 'primary' : ''}" data-act="cr-judge" data-cid="${esc(opts.review)}" data-rid="${esc(r.id)}" data-v="notcanon" aria-pressed="${r.status === 'notcanon'}">Not canon</button></td>` : ''}</tr>`; }).join('')}</tbody></table></div>`;
}

/* ---------------------------------------------------------------- Race Control's side */
ACTIONS['cr-judge'] = d => {
  if (!S.isGm) return; const c = get('characters', d.cid); if (!c) return;
  const doc = charDoc(c.id); doc.career = careerRows(doc).map(r => r.id === d.rid ? Object.assign({}, r, { status: d.v, judgedAt: nowIso() }) : r);
  const r = careerRows(c).find(x => x.id === d.rid) || {};
  run(async () => { await Data.put('characters', c.id, doc); await Data.audit('career.judge', `${c.name}: ${r.years} ${seriesLabel(r)} marked ${d.v === 'canon' ? 'canon' : 'not canon'}`); });
};
/* Approving a character makes any seasons still waiting canon (Race Control marks the ones it won't accept first). */
const _genApproveCareer = ACTIONS['gen-approve'];
ACTIONS['gen-approve'] = d => {
  const c = get('characters', d.id);
  if (c && careerRows(c).some(r => (r.status || 'pending') === 'pending')) {
    const doc = charDoc(c.id); doc.career = careerRows(doc).map(r => (r.status || 'pending') === 'pending' ? Object.assign({}, r, { status: 'canon', judgedAt: nowIso() }) : r);
    Data.put('characters', c.id, doc).then(() => _genApproveCareer(d)).catch(e => toast(e.message || String(e), true));
    return;
  }
  _genApproveCareer(d);
};
/* Approved characters with new or changed seasons. */
function careerQueueHtml() {
  const waiting = list('characters').filter(c => !c.retired && charStatus(c) === 'approved' && careerRows(c).some(r => (r.status || 'pending') === 'pending'));
  if (!waiting.length) return '';
  return `<section><h2 class="section-h">Career record changes <span class="count">${waiting.length}</span></h2>
    ${waiting.map(c => `<article class="card"><h3>${esc(c.name)}</h3><p class="muted small">${esc(charRoleName(c.role))}. New or changed seasons are awaiting approval.</p>${careerTableHtml(careerRows(c), { review: c.id })}</article>`).join('')}</section>`;
}

/* ---------------------------------------------------------------- the character page */
/* F1 SIM seasons from the results: one row per series and season. */
function simSeasons(personId) {
  const by = new Map();
  f1Record(personId).forEach(x => { const k = wSeries(x.w) + '|' + wSeason(x.w), o = by.get(k) || { sid: wSeries(x.w), sea: wSeason(x.w), starts: 0, wins: 0, podiums: 0, poles: 0, pts: 0, team: x.r.teamId };
    o.pts += x.r.points || 0; o.team = x.r.teamId;
    if (x.w.session === 'gp') { o.starts += 1; if (x.r.position === 1) o.wins += 1; if (x.r.position && x.r.position <= 3) o.podiums += 1; if (x.pole) o.poles += 1; }
    by.set(k, o); });
  return [...by.values()].map(o => {
    const tally = new Map();
    list('f1_weekends').filter(w => w.status === 'finished' && wSeries(w) === o.sid && wSeason(w) === o.sea).forEach(w => (w.results || []).forEach(r => {
      const t = tally.get(r.personId) || { pts: 0, wins: 0 }; t.pts += r.points || 0; if (w.session !== 'sprint' && r.position === 1) t.wins += 1; tally.set(r.personId, t); }));
    const order = [...tally.entries()].sort((a, b) => b[1].pts - a[1].pts || b[1].wins - a[1].wins).map(e => e[0]);
    const sd = seasonDoc(o.sea);
    return Object.assign(o, { pos: order.indexOf(personId) + 1, done: sd.status === 'archived', seasonName: sd.name, seriesName: seriesDoc(o.sid).name });
  }).sort((a, b) => String(a.seasonName).localeCompare(String(b.seasonName)));
}
function careerRecordHtml(p, c) {
  const sim = (p && (p.kind === 'driver' || !p.kind)) ? simSeasons(p.id) : [];
  const own = !!(c && (c.userId === S.uid || S.isGm));
  const rows = careerRows(c).filter(r => r.status === 'canon' || own);
  if (!sim.length && !rows.length) return own && c && c.role === 'driver' ? `<section class="card career-record"><h2>Career record</h2><p class="muted">No seasons yet. Add their career before F1 SIM on the application page.</p><div class="btn-row"><button class="btn" data-act="char-open" data-id="${esc(c.id)}">Add a season</button></div></section>` : '';
  const canon = rows.filter(r => r.status === 'canon');
  const titles = canon.filter(r => String(r.pos) === '1').length + sim.filter(o => o.done && o.pos === 1).length;
  const sum = k => canon.reduce((s, r) => s + (Number(r[k]) || 0), 0) + sim.reduce((s, o) => s + (o[k] || 0), 0);
  const groups = CAREER_GROUPS.map(([g]) => [g, rows.filter(r => careerGroupOf(r.series) === g)]).filter(x => x[1].length);
  return `<section class="card career-record"><h2>Career record</h2>
    <div class="metrics"><div class="metric"><b>${titles}</b><span>${titles === 1 ? 'Title' : 'Titles'}</span></div><div class="metric"><b>${sum('wins')}</b><span>Wins</span></div><div class="metric"><b>${sum('podiums')}</b><span>Podiums</span></div><div class="metric"><b>${sum('poles')}</b><span>Poles</span></div></div>
    ${sim.length ? `<h3>F1 SIM</h3><div class="scroll-x"><table class="data compact career"><thead><tr><th>Season</th><th>Series</th><th>Team</th><th class="num">Wins</th><th class="num">Podiums</th><th class="num">Poles</th><th class="num">Points</th><th>Championship</th></tr></thead><tbody>
      ${sim.map(o => `<tr><td>${esc(o.seasonName)}</td><td><b>${esc(o.seriesName)}</b></td><td><span class="f1-bar" style="background:${esc(f1Colour(o.team))}"></span>${esc((F1.team(o.team) || {}).name || '')}</td><td class="num">${o.wins}</td><td class="num">${o.podiums}</td><td class="num">${o.poles}</td><td class="num"><b>${o.pts}</b></td>
        <td>${o.done && o.pos === 1 ? '<span class="tag trophy">Champion</span>' : o.pos ? `${ordinal(o.pos)}${o.done ? '' : ' <span class="muted small">so far</span>'}` : ''}</td></tr>`).join('')}</tbody></table></div>` : ''}
    ${groups.map(([g, rs]) => `<h3>${esc(g)}</h3>${careerTableHtml(rs, { status: own })}`).join('')}
    ${own && rows.some(r => r.status !== 'canon') ? '<p class="muted small">Only you and Race Control see seasons that aren’t canon yet.</p>' : ''}</section>`;
}
ACTIONS['char-open'] = d => { S.ui.charEdit = d.id; go('character'); };

/* Race Control's queue also lists approved characters with seasons to check. */
const _chargenQueueCareer = chargenQueueHtml;
chargenQueueHtml = function () { return _chargenQueueCareer() + careerQueueHtml(); };

/* =====================================================================
   F1 SIM — character sheet exports and the acceptance post.
   Any character's sheet can be exported as a photo card (in the style of
   the driver cards) or as a Word file laid out to open in Google Docs.
   When Race Control approves a character, the acceptance card is posted
   to Discord, @mentioning the player when the character has their Discord
   user ID (DISCORD_WEBHOOK_APPROVALS, else the default channel).
   ===================================================================== */
'use strict';

const SHEET_KINDS = [['sheet', 'Character sheet'], ['accepted', 'Acceptance card']];
/* Everything the exports need about a character, canon only. */
function sheetData(cid) {
  const c = get('characters', cid); if (!c) return null;
  const pid = f1PcId(c.id), p = F1.person(pid), seat = typeof primarySeat === 'function' ? primarySeat(c.id) : F1.seats().find(s => s.holderCharId === c.id);
  const team = seat ? F1.team(seat.teamId) : null, driver = c.role === 'driver', g = c.gen || {};
  let ratings = null;
  if (driver) ratings = p && p.approved ? f1DevApply(Object.assign({}, F1_ROOKIE, p), c.id) : rolledRatings(c);
  const canon = careerRows(c).filter(r => r.status === 'canon'), sim = p ? simSeasons(pid) : [];
  const titles = canon.filter(r => String(r.pos) === '1').length + sim.filter(o => o.done && o.pos === 1).length;
  const sum = k => canon.reduce((s, r) => s + (Number(r[k]) || 0), 0) + sim.reduce((s, o) => s + (o[k] || 0), 0);
  const rels = list('f1_relations').filter(r => r.personId === pid || r.otherId === pid).map(r => { const other = r.personId === pid ? r.otherId : r.personId;
    return { who: (F1.person(other) || {}).name || other, kind: (typeof REL_KINDS !== 'undefined' ? (REL_KINDS.find(x => x[0] === r.kind) || [r.kind, r.kind])[1] : r.kind), note: r.note || '' }; });
  const diary = list('f1_diary').filter(d => d.charId === c.id).sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 3);
  const y = typeof yearsOf === 'function' ? yearsOf(g.years) : null, b = typeof bracketOf === 'function' ? bracketOf(g.bracket) : null;
  const style = ratings && ratings.style ? (F1_STYLES.find(s => s[0] === ratings.style) || ['', ratings.style])[1] : '';
  return { c, p, pid, seat, team, color: team ? team.color : '#E10600', driver, role: charRoleName(c.role), status: charStatus(c), ratings, canon, sim, titles,
    totals: { starts: sum('starts'), wins: sum('wins'), podiums: sum('podiums'), poles: sum('poles') }, rels, diary, style,
    background: b ? b.name : '', years: ratings && ratings.years != null ? `${ratings.years}` : (y ? y.label : ''),
    series: seat ? seriesDoc(seat.seriesId || F1.team(seat.teamId).seriesId || 'f1').name : '' };
}
function wrapLines(g, text, maxW, maxLines) {
  const words = String(text || '').replace(/\s+/g, ' ').trim().split(' '), out = []; let line = '';
  for (const w of words) { const t = line ? line + ' ' + w : w; if (g.measureText(t).width > maxW && line) { out.push(line); line = w; if (out.length === maxLines) break; } else line = t; }
  if (out.length < maxLines && line) out.push(line);
  if (out.length === maxLines && words.join(' ').length > out.join(' ').length) out[maxLines - 1] = out[maxLines - 1].replace(/\s*\S*$/, '') + '…';
  return out;
}
async function drawCharCard(cid, kind) {
  const d = sheetData(cid); if (!d) return null;
  const { c, color: col } = d, W = 1080, H = 1350, cv = document.createElement('canvas'); cv.width = W; cv.height = H; const g = cv.getContext('2d');
  try { await Promise.all(['700 200px "Titillium Web"', '600 40px "Titillium Web"'].map(f => document.fonts.load(f))); } catch (e) { /* fall back */ }
  const T = EXP_THEMES.dark, img = await loadImg(c.portraitUrl), logo = await loadImg(leagueLogo());
  g.fillStyle = '#1C1D22'; g.fillRect(0, 0, W, H);
  const grad = g.createLinearGradient(0, 0, W * 0.9, H * 0.7); grad.addColorStop(0, col); grad.addColorStop(0.55, '#1C1D22'); g.globalAlpha = 0.85; g.fillStyle = grad; g.fillRect(0, 0, W, H); g.globalAlpha = 1;
  if (c.number) { g.font = cond(700, 620); g.fillStyle = 'rgba(255,255,255,0.06)'; g.textAlign = 'right'; g.fillText(String(c.number), W - 10, 700); g.textAlign = 'left'; }
  drawMark(g, 64, 64, Object.assign({}, T, { ink: '#FFFFFF' }), logo);
  const label = kind === 'accepted' ? 'Welcome to the grid' : 'Character sheet';
  g.font = cond(700, 50); const lw = g.measureText(label).width + 44; g.fillStyle = kind === 'accepted' ? '#E10600' : col; g.beginPath(); g.moveTo(74, 140); g.lineTo(64 + lw + 10, 140); g.lineTo(64 + lw, 210); g.lineTo(64, 210); g.closePath(); g.fill();
  g.fillStyle = '#FFFFFF'; g.fillText(label, 86, 193);
  const parts = String(c.name).split(' '), last = parts.pop(), first = parts.join(' ');
  if (kind === 'accepted') {
    /* Big portrait, the name, the role and seat, and an approved stamp. */
    const px = 240, py = 250, pw = 600, ph = 640;
    drawPhoto(g, img, px, py, pw, ph, 10, { name: c.name }, T);
    const fade = g.createLinearGradient(0, py + ph - 220, 0, py + ph); fade.addColorStop(0, 'rgba(28,29,34,0)'); fade.addColorStop(1, 'rgba(28,29,34,0.95)'); g.fillStyle = fade; g.fillRect(px, py + ph - 220, pw, 220);
    g.save(); g.translate(W - 260, 300); g.rotate(-0.18); g.font = cond(700, 64); const sw = g.measureText('APPROVED').width + 56; g.strokeStyle = '#E10600'; g.lineWidth = 8; g.strokeRect(-sw / 2, -52, sw, 104); g.fillStyle = '#E10600'; g.textAlign = 'center'; g.fillText('APPROVED', 0, 22); g.restore(); g.textAlign = 'left';
    g.fillStyle = '#FFFFFF'; g.font = cond(600, 56); g.textAlign = 'center'; g.fillText(first, W / 2, 980);
    let size = 150; g.font = cond(700, size); while (g.measureText(last.toUpperCase()).width > W - 120 && size > 70) { size -= 6; g.font = cond(700, size); } g.fillText(last.toUpperCase(), W / 2, 980 + size * 0.9);
    g.font = cond(600, 40); g.fillStyle = 'rgba(255,255,255,0.88)';
    const line = d.team ? `${d.role} for ${d.team.name}${d.driver && c.number ? `, car #${c.number}` : ''}` : `${d.role}${d.driver && c.number ? `, car #${c.number}` : ''}`;
    g.fillText(line, W / 2, 1210); g.font = bodyF(500, 28); g.fillStyle = 'rgba(255,255,255,0.7)'; g.fillText(d.team ? (d.series || '') : 'Seat to be confirmed', W / 2, 1258); g.textAlign = 'left';
  } else {
    /* Portrait on the right; name, particulars, ratings, record and story on the left. */
    drawPhoto(g, img, 600, 250, 416, 500, 10, { name: c.name }, T);
    g.fillStyle = '#FFFFFF'; g.font = cond(600, 44); g.fillText(first, 64, 300);
    let size = 120; g.font = cond(700, size); while (g.measureText(last.toUpperCase()).width > 510 && size > 56) { size -= 6; g.font = cond(700, size); } g.fillText(last.toUpperCase(), 60, 300 + size * 0.92);
    let y = 300 + size + 40;
    g.font = cond(600, 32); g.fillStyle = 'rgba(255,255,255,0.9)'; g.fillText(d.team ? `${d.role}, ${d.team.name}` : d.role, 64, y); y += 52;
    const facts = [['Nationality', c.nationality], ['From', c.birthplace], d.driver ? ['Car', [c.number ? '#' + c.number : '', c.code].filter(Boolean).join('  ')] : null, d.driver ? ['Years racing', d.years] : null, d.driver ? ['Style', d.style] : null].filter(x => x && x[1]);
    facts.slice(0, 5).forEach(([k, v]) => { g.font = bodyF(500, 24); g.fillStyle = 'rgba(255,255,255,0.6)'; g.fillText(k, 64, y); g.font = bodyF(600, 28); g.fillStyle = '#FFFFFF'; g.fillText(String(v), 230, y); y += 42; });
    let by = 800;
    if (d.ratings) {
      F1_RATINGS.forEach(([k, l], i) => { const v = d.ratings[k]; if (v == null) return; const col2 = i % 2, row = Math.floor(i / 2), x = 64 + col2 * 486, yy = by + row * 70;
        g.font = bodyF(600, 24); g.fillStyle = 'rgba(255,255,255,0.75)'; g.fillText(l, x, yy); g.textAlign = 'right'; g.font = cond(700, 34); g.fillStyle = '#FFFFFF'; g.fillText(String(v), x + 440, yy + 4); g.textAlign = 'left';
        g.fillStyle = 'rgba(255,255,255,0.15)'; g.fillRect(x, yy + 14, 440, 10); g.fillStyle = col; g.fillRect(x, yy + 14, 440 * Math.min(1, v / 100), 10); });
      by += 230;
    }
    const tiles = [['Titles', d.titles], ['Wins', d.totals.wins], ['Podiums', d.totals.podiums], ['Poles', d.totals.poles]];
    tiles.forEach(([k, v], i) => { const x = 64 + i * 238; g.fillStyle = 'rgba(255,255,255,0.08)'; g.fillRect(x, by, 220, 100); g.fillStyle = '#FFFFFF'; g.font = cond(700, 52); g.fillText(String(v), x + 18, by + 58); g.font = bodyF(500, 22); g.fillStyle = 'rgba(255,255,255,0.7)'; g.fillText(k, x + 18, by + 88); });
    by += 140;
    if (c.bio && by < H - 120) { g.font = bodyF(400, 26); g.fillStyle = 'rgba(255,255,255,0.85)'; wrapLines(g, c.bio, W - 128, Math.max(1, Math.floor((H - 90 - by) / 36))).forEach((l, i) => g.fillText(l, 64, by + i * 36)); }
  }
  g.fillStyle = col; g.fillRect(0, H - 20, W, 20);
  g.font = bodyF(500, 20); g.fillStyle = 'rgba(255,255,255,0.55)'; g.textAlign = 'right'; g.fillText(stampText(), W - 40, H - 22); g.textAlign = 'left';
  return new Promise(ok => cv.toBlob(ok, 'image/png'));
}

/* ---------------------------------------------------------------- the Word file for Google Docs */
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = u8 => { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
/* A plain (stored, uncompressed) zip: no folder entries, which some cloud editors refuse. */
function zipStore(files) {
  const enc = new TextEncoder(), parts = [], central = []; let offset = 0;
  const le = (n, b) => { const a = new Uint8Array(b); for (let i = 0; i < b; i++) a[i] = (n >>> (8 * i)) & 0xFF; return a; };
  files.forEach(f => {
    const name = enc.encode(f.name), data = typeof f.data === 'string' ? enc.encode(f.data) : f.data, crc = crc32(data);
    const head = [le(0x04034b50, 4), le(20, 2), le(0x0800, 2), le(0, 2), le(0, 2), le(0x21, 2), le(crc, 4), le(data.length, 4), le(data.length, 4), le(name.length, 2), le(0, 2), name];
    const cen = [le(0x02014b50, 4), le(20, 2), le(20, 2), le(0x0800, 2), le(0, 2), le(0, 2), le(0x21, 2), le(crc, 4), le(data.length, 4), le(data.length, 4), le(name.length, 2), le(0, 2), le(0, 2), le(0, 2), le(0, 2), le(0, 4), le(offset, 4), name];
    head.concat([data]).forEach(p => { parts.push(p); offset += p.length; }); cen.forEach(p => central.push(p));
  });
  const cenSize = central.reduce((s, p) => s + p.length, 0);
  const end = [le(0x06054b50, 4), le(0, 2), le(0, 2), le(files.length, 2), le(files.length, 2), le(cenSize, 4), le(offset, 4), le(0, 2)];
  const all = parts.concat(central, end), out = new Uint8Array(all.reduce((s, p) => s + p.length, 0)); let o = 0; all.forEach(p => { out.set(p, o); o += p.length; });
  return out;
}
const xe = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const hex = c => String(c || '#E10600').replace('#', '').toUpperCase().slice(0, 6);
function docxRun(text, o) { const p = o || {};
  return `<w:r><w:rPr><w:rFonts w:ascii="Titillium Web" w:hAnsi="Titillium Web" w:cs="Titillium Web"/>${p.b ? '<w:b/>' : ''}${p.i ? '<w:i/>' : ''}${p.color ? `<w:color w:val="${p.color}"/>` : ''}<w:sz w:val="${p.sz || 21}"/></w:rPr><w:t xml:space="preserve">${xe(text)}</w:t></w:r>`; }
function docxPara(runs, o) { const p = o || {};
  return `<w:p><w:pPr>${p.style ? `<w:pStyle w:val="${p.style}"/>` : ''}${p.keep ? '<w:keepNext/>' : ''}${p.rule ? `<w:pBdr><w:bottom w:val="single" w:sz="18" w:space="4" w:color="${p.rule}"/></w:pBdr>` : ''}<w:spacing w:before="${p.before || 0}" w:after="${p.after == null ? 100 : p.after}"/>${p.align ? `<w:jc w:val="${p.align}"/>` : ''}</w:pPr>${runs}</w:p>`; }
function docxCell(content, w, o) { const p = o || {};
  return `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/>${p.span ? `<w:gridSpan w:val="${p.span}"/>` : ''}${p.fill ? `<w:shd w:val="clear" w:color="auto" w:fill="${p.fill}"/>` : ''}<w:tcMar><w:top w:w="80" w:type="dxa"/><w:left w:w="120" w:type="dxa"/><w:bottom w:w="80" w:type="dxa"/><w:right w:w="120" w:type="dxa"/></w:tcMar>${p.valign ? `<w:vAlign w:val="${p.valign}"/>` : ''}</w:tcPr>${content || docxPara('')}</w:tc>`; }
function docxTable(widths, rows, o) { const p = o || {}, total = widths.reduce((s, x) => s + x, 0), line = p.lines === false ? 'nil' : 'single';
  return `<w:tbl><w:tblPr><w:tblW w:w="${total}" w:type="dxa"/><w:tblBorders><w:top w:val="nil"/><w:left w:val="nil"/><w:bottom w:val="${line}" w:sz="4" w:space="0" w:color="D0D3D8"/><w:right w:val="nil"/><w:insideH w:val="${line}" w:sz="4" w:space="0" w:color="D0D3D8"/><w:insideV w:val="nil"/></w:tblBorders><w:tblLayout w:type="fixed"/></w:tblPr>
    <w:tblGrid>${widths.map(x => `<w:gridCol w:w="${x}"/>`).join('')}</w:tblGrid>${rows.join('')}</w:tbl>${docxPara('', { after: 120 })}`; }
const docxRow = cells => `<w:tr><w:trPr><w:cantSplit/></w:trPr>${cells.join('')}</w:tr>`;
function docxImage(rid, cxIn, cyIn) { const cx = Math.round(cxIn * 914400), cy = Math.round(cyIn * 914400);
  return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="1" name="Portrait"/><wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr>
    <a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
    <pic:nvPicPr><pic:cNvPr id="1" name="portrait.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>
    <pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`; }
async function portraitPng(url) {
  const img = await loadImg(url); if (!img) return null;
  const size = Math.min(900, Math.max(img.width, img.height)), k = size / Math.max(img.width, img.height), cv = document.createElement('canvas');
  cv.width = Math.round(img.width * k); cv.height = Math.round(img.height * k); cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
  const blob = await new Promise(ok => cv.toBlob(ok, 'image/png')); return blob ? { bytes: new Uint8Array(await blob.arrayBuffer()), w: cv.width, h: cv.height } : null;
}
async function sheetDocx(cid) {
  const d = sheetData(cid); if (!d) return null;
  const { c } = d, accent = hex(d.color), DARK = '1C1D22', RED = 'E10600', GREY = '6B7280', LIGHT = 'F2F3F5', FULL = 9360;
  const pic = await portraitPng(c.portraitUrl);
  const H2 = t => docxPara(docxRun(t, { b: true, i: true, sz: 30, color: DARK }), { keep: true, before: 280, after: 80, rule: accent });
  const P = (t, o) => docxPara(docxRun(t, Object.assign({ sz: 21 }, o || {})), { after: 120 });
  const body = [];
  /* Header: portrait and name on a dark band. */
  const nameRuns = docxPara(docxRun('F1 SIM  ·  CHARACTER SHEET', { b: true, sz: 18, color: RED }), { after: 60 })
    + docxPara(docxRun(c.name, { b: true, i: true, sz: 56, color: 'FFFFFF' }), { after: 40 })
    + docxPara(docxRun([d.role, d.team ? d.team.name : '', d.series].filter(Boolean).join('  ·  '), { sz: 24, color: 'C9CCD2' }), { after: 40 })
    + docxPara(docxRun([c.code, c.number ? '#' + c.number : '', c.nationality].filter(Boolean).join('  ·  '), { b: true, sz: 24, color: accent }), { after: 40 })
    + docxPara(docxRun(d.status === 'approved' ? 'Approved by Race Control' : d.status === 'pending' ? 'Application with Race Control' : 'Draft application', { sz: 18, color: '9AA0A8' }), { after: 0 });
  const picW = 2.0, picH = pic ? Math.min(2.6, picW * pic.h / pic.w) : 0;
  body.push(docxTable(pic ? [3200, FULL - 3200] : [FULL], [docxRow((pic ? [docxCell(docxPara(docxImage('rIdImg1', picW, picH), { after: 0, align: 'center' }), 3200, { fill: DARK, valign: 'center' })] : [])
    .concat([docxCell(nameRuns, pic ? FULL - 3200 : FULL, { fill: DARK, valign: 'center' })]))], { lines: false }));
  body.push(docxPara('', { rule: RED, after: 160 }));
  /* Particulars. */
  const facts = [['Role', d.role], ['Team', d.team ? d.team.name : 'No seat yet'], ['Nationality', c.nationality], ['From', c.birthplace], ['Nickname', c.nickname], ['Face claim', c.faceclaim],
    d.driver ? ['Three-letter code', c.code] : null, d.driver ? ['Car number', c.number ? '#' + c.number : ''] : null, d.driver ? ['Background', d.background] : null,
    d.driver ? ['Years in racing', d.years] : null, d.driver ? ['Driving style', d.style] : null, d.driver ? ['Helmet', c.helmet] : null, ['Discord', c.discord]].filter(x => x && x[1]);
  body.push(H2('Particulars'));
  body.push(docxTable([2600, FULL - 2600], facts.map(([k, v], i) => docxRow([docxCell(docxPara(docxRun(k, { b: true, sz: 20, color: GREY }), { after: 0 }), 2600, { fill: i % 2 ? 'FFFFFF' : LIGHT }),
    docxCell(docxPara(docxRun(String(v), { sz: 21 }), { after: 0 }), FULL - 2600, { fill: i % 2 ? 'FFFFFF' : LIGHT })]))));
  /* Ratings, as numbers and bars. */
  if (d.ratings) {
    body.push(H2('Ratings'));
    body.push(docxTable([2600, 900, FULL - 3500], F1_RATINGS.filter(([k]) => d.ratings[k] != null).map(([k, l], i) => { const v = d.ratings[k];
      return docxRow([docxCell(docxPara(docxRun(l, { b: true, sz: 20, color: GREY }), { after: 0 }), 2600, { fill: i % 2 ? 'FFFFFF' : LIGHT }),
        docxCell(docxPara(docxRun(String(v), { b: true, sz: 24 }), { after: 0, align: 'right' }), 900, { fill: i % 2 ? 'FFFFFF' : LIGHT }),
        docxCell(docxPara(docxRun('█'.repeat(Math.max(1, Math.round(v / 4))), { sz: 18, color: accent }) + docxRun('█'.repeat(Math.max(0, 25 - Math.round(v / 4))), { sz: 18, color: 'E3E5E9' }), { after: 0 }), FULL - 3500, { fill: i % 2 ? 'FFFFFF' : LIGHT })]); })));
  }
  /* Story. */
  if (c.personality) { body.push(H2('Personality')); String(c.personality).split(/\n+/).filter(Boolean).forEach(t => body.push(P(t))); }
  if (c.bio) { body.push(H2('Backstory')); String(c.bio).split(/\n+/).filter(Boolean).forEach(t => body.push(P(t))); }
  if (typeof FLAVOUR !== 'undefined' && flavourCount(c)) { body.push(H2('More about them')); FLAVOUR.filter(([k]) => String(c[k] || '').trim()).forEach(([k, l]) => { body.push(docxPara(docxRun(l, { b: true, sz: 21, color: accent }), { after: 40, keep: true })); String(c[k]).split(/\n+/).filter(Boolean).forEach(t => body.push(P(t))); }); }
  if (d.driver && c.junior) { body.push(H2('Before Formula 1')); String(c.junior).split(/\n+/).filter(Boolean).forEach(t => body.push(P(t))); }
  /* Career record. */
  if (d.sim.length || d.canon.length) {
    body.push(H2('Career record'));
    body.push(P(`${d.titles} ${d.titles === 1 ? 'title' : 'titles'}  ·  ${d.totals.wins} wins  ·  ${d.totals.podiums} podiums  ·  ${d.totals.poles} poles`, { b: true, color: accent, sz: 22 }));
    const cw = [900, 2500, 2200, 760, 1040, 760, 1200], head = ['Year', 'Series', 'Team', 'Wins', 'Podiums', 'Poles', 'Finish'];
    const headRow = docxRow(head.map((h, i) => docxCell(docxPara(docxRun(h, { b: true, sz: 18, color: 'FFFFFF' }), { after: 0, align: i >= 3 && i < 6 ? 'right' : null }), cw[i], { fill: DARK })));
    const rows = d.sim.map(o => [o.seasonName, `F1 SIM: ${o.seriesName}`, (F1.team(o.team) || {}).name || '', o.wins, o.podiums, o.poles, o.done && o.pos === 1 ? 'Champion' : o.pos ? ordinal(o.pos) + (o.done ? '' : ' so far') : ''])
      .concat(d.canon.map(r => [r.years, seriesLabel(r), r.team, r.wins, r.podiums, r.poles, String(r.pos) === '1' ? 'Champion' : r.pos ? posLabel(r.pos) : '']));
    body.push(docxTable(cw, [headRow].concat(rows.map((r, j) => docxRow(r.map((v, i) => docxCell(docxPara(docxRun(v === '' || v == null ? '–' : String(v), { sz: 19, b: i === 6 && v === 'Champion', color: i === 6 && v === 'Champion' ? RED : null }), { after: 0, align: i >= 3 && i < 6 ? 'right' : null }), cw[i], { fill: j % 2 ? 'FFFFFF' : LIGHT })))))));
    const notes = d.canon.filter(r => r.notes); if (notes.length) notes.forEach(r => body.push(P(`${r.years} ${seriesLabel(r)}: ${r.notes}`, { sz: 19, color: GREY })));
  }
  if (d.rels.length) { body.push(H2('Relationships')); d.rels.forEach(r => body.push(P(`${r.who}: ${r.kind}${r.note ? `. ${r.note}` : ''}`))); }
  if (d.diary.length) { body.push(H2('From the diary')); d.diary.forEach(e => { body.push(docxPara(docxRun(`${e.title}`, { b: true, sz: 22 }) + docxRun(`   ${fmtDate(e.at)}`, { sz: 18, color: GREY }), { after: 40, keep: true })); body.push(P(String(e.body || '').slice(0, 800))); }); }
  body.push(docxPara(docxRun(`Exported from F1 SIM on ${stampText()}.`, { i: true, sz: 17, color: GREY }), { before: 360, after: 0 }));
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
<w:body>${body.join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1000" w:right="1273" w:bottom="1000" w:left="1273" w:header="500" w:footer="500" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Titillium Web" w:hAnsi="Titillium Web" w:cs="Titillium Web" w:eastAsia="Titillium Web"/><w:sz w:val="21"/><w:lang w:val="en-GB"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="100" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>`;
  const ct = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
  const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>${pic ? '<Relationship Id="rIdImg1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/portrait.png"/>' : ''}</Relationships>`;
  const files = [{ name: '[Content_Types].xml', data: ct }, { name: '_rels/.rels', data: rels }, { name: 'word/document.xml', data: doc }, { name: 'word/styles.xml', data: styles }, { name: 'word/_rels/document.xml.rels', data: docRels }];
  if (pic) files.push({ name: 'word/media/portrait.png', data: pic.bytes });
  return new Blob([zipStore(files)], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
}

/* ---------------------------------------------------------------- the export panel */
const fileSafe = s => String(s || 'character').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '');
ACTIONS['sheet-open'] = d => { S.ui.sheet = { cid: d.id, kind: 'sheet', url: null, blob: null }; openDrawer('sheet'); sheetRefresh(); if (S.isGm) discordChannels().then(() => renderOverlay()).catch(() => {}); };
async function sheetRefresh() { const x = S.ui.sheet; if (!x) return; const blob = await drawCharCard(x.cid, x.kind); if (S.ui.sheet !== x || !blob) return; if (x.url) URL.revokeObjectURL(x.url); x.blob = blob; x.url = URL.createObjectURL(blob); renderOverlay(); }
CHANGES['sheet-kind'] = v => { const x = S.ui.sheet; if (!x) return; x.kind = v; x.url = null; renderOverlay(); sheetRefresh(); };
DRAWERS.sheet = function () {
  const x = S.ui.sheet || {}, c = get('characters', x.cid); if (!c) return '';
  return `<header><div><h2>Export ${esc(c.name)}</h2><p>A photo card, or a document for Google Docs.</p></div><button class="btn ghost" data-act="close-drawer">Close</button></header>
    <div class="body"><h3>Photo card</h3><label class="field" style="max-width:320px">Card<select id="sheet-kind" data-change="sheet-kind">${SHEET_KINDS.map(([k, l]) => `<option value="${k}" ${x.kind === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    ${x.url ? `<img class="card-preview tx-preview" src="${x.url}" alt="${esc(c.name)}’s ${x.kind === 'accepted' ? 'acceptance card' : 'character sheet'}">` : '<p class="muted">Drawing the card…</p>'}
    <div class="btn-row"><button class="btn primary" data-act="sheet-png" ${x.url ? '' : 'disabled'}>Download the card</button>${S.isGm ? `<button class="btn" data-act="sheet-discord" ${x.url ? '' : 'disabled'}>Post to Discord${x.kind === 'accepted' && c.discord ? ` mentioning @${esc(c.discord)}` : ''}</button>` : ''}${x.posted ? `<span class="tag player">Posted to #${esc(x.posted)}</span>` : ''}</div>
    <h3>Google Doc</h3><p class="small">A styled document of the whole sheet: particulars, ratings, story, career record, relationships and recent diary entries.</p>
    <div class="btn-row"><button class="btn" data-act="sheet-docx">Download for Google Docs (.docx)</button><button class="btn ghost" data-act="io-ch-one" data-id="${esc(c.id)}">Download as JSON</button></div>
    <p class="muted small">To open it in Google Docs: in Google Drive choose <b>New</b>, then <b>File upload</b>, pick the file, then open it with <b>Google Docs</b>. It opens in Word too.</p></div>`;
};
ACTIONS['sheet-png'] = () => { const x = S.ui.sheet; if (!x || !x.url) return; const c = get('characters', x.cid), a = document.createElement('a'); a.href = x.url; a.download = `${fileSafe(c && c.name)}-${x.kind === 'accepted' ? 'acceptance' : 'sheet'}.png`; document.body.appendChild(a); a.click(); a.remove(); };
ACTIONS['sheet-docx'] = () => { const x = S.ui.sheet; if (!x) return; const c = get('characters', x.cid);
  run(async () => { const blob = await sheetDocx(x.cid); const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = `${fileSafe(c && c.name)}-character-sheet.docx`; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 3000); }, 'Character sheet downloaded.'); };

/* ---------------------------------------------------------------- the acceptance post */
function acceptText(c) {
  const d = sheetData(c.id);
  return `🏁 **Welcome to the grid!** ${c.name} has been approved as ${d.role.toLowerCase()}${d.team ? ` for ${d.team.name}` : ''}.`;
}
async function postAcceptance(cid, chosen) {
  const c = get('characters', cid); if (!c) return null;
  const blob = await drawCharCard(cid, 'accepted');
  return discordSend('approvals', Object.assign({ content: acceptText(c) }, c.discord ? { mention_username: c.discord } : {}), { blob, name: `${fileSafe(c.name)}-approved.png` }, chosen);
}
ACTIONS['sheet-discord'] = () => { const x = S.ui.sheet; if (!x || !x.blob) return; const c = get('characters', x.cid);
  run(async () => {
    x.posted = x.kind === 'accepted' ? await postAcceptance(x.cid) : await discordSend('cards', { content: `**Character sheet:** ${c.name}` }, { blob: x.blob, name: `${fileSafe(c.name)}-sheet.png` });
    await Data.audit('discord.sheet', `${c.name}: ${x.kind === 'accepted' ? 'acceptance card' : 'character sheet'} posted to Discord #${x.posted}`);
  }, 'Posted to Discord.'); };
const waitFor = (test, ms) => new Promise(ok => { const t0 = Date.now(), tick = () => { if (test()) ok(true); else if (Date.now() - t0 > ms) ok(false); else setTimeout(tick, 200); }; tick(); });
/* After approving, post the acceptance card (unless Race Control untick it). */
const _genApproveSheet = ACTIONS['gen-approve'];
ACTIONS['gen-approve'] = d => {
  const post = ((S.ui.form.postAccept || {})[d.id]) !== false;
  _genApproveSheet(d);
  if (!post) return;
  waitFor(() => charStatus(get('characters', d.id) || {}) === 'approved', 15000).then(ok => {
    if (!ok) return; const c = get('characters', d.id);
    postAcceptance(d.id).then(ch => { const r = S.discordLast || {};
      toast(`Acceptance card posted to Discord #${ch}${!c || !c.discord ? ' (no Discord username on the character, so no @mention)' : r.mentioned ? `, pinging @${c.discord}` : r.bot ? `; @${c.discord} wasn’t found on the server, so it’s written as text` : `, with @${c.discord} as text (set up the Discord bot to ping players)`}.`); })
      .catch(e => toast(`The character is approved, but the Discord post didn’t go: ${e.message || e}`, true));
  });
};

/* ---------------------------------------------------------------- picture and face claim on the character form */
CHANGES['ch-portrait'] = (v, d, el) => {
  const file = el.files && el.files[0]; if (!file || !S.ui.form.ch) return;
  if (!/^image\//.test(file.type)) { toast('Choose a picture: a JPEG, PNG or WebP.', true); return; }
  S.ui.chUploading = true; renderOverlay(); if (S.ui.charInline || S.route === 'newchar') render();
  (async () => { try { const blob = await shrinkImage(file, 900), assets = await window.claude.use('assets'), up = await assets.upload(blob, { type: 'image/jpeg' });
      if (S.ui.form.ch) S.ui.form.ch.portraitUrl = up.url; toast('Picture uploaded. Save the character to keep it.'); }
    catch (e) { toast('The picture didn’t upload: ' + (e.message || e), true); }
    S.ui.chUploading = false; renderOverlay(); if (S.ui.charInline || S.route === 'newchar') render(); })();
  el.value = '';
};
ACTIONS['ch-portrait-remove'] = () => { if (S.ui.form.ch) { S.ui.form.ch.portraitUrl = null; renderOverlay(); if (S.ui.charInline || S.route === 'newchar') render(); } };
/* Sending without a picture or face claim asks first. */
const _genSubmitPhoto = ACTIONS['gen-submit'];
ACTIONS['gen-submit'] = d => {
  const c = get('characters', S.ui.charEdit); if (!c) return;
  const missing = [!c.portraitUrl ? 'picture' : '', !String(c.faceclaim || '').trim() ? 'face claim' : ''].filter(Boolean);
  if (missing.length) askConfirm(`There’s no ${missing.join(' or ')} yet (add ${missing.length > 1 ? 'them' : 'it'} with Edit details). Send the application anyway?`, 'Send anyway', () => _genSubmitPhoto(d));
  else _genSubmitPhoto(d);
};

/* =====================================================================
   F1 SIM — Home, Paddock, Race Control desk, accounts and backups.
   ===================================================================== */
'use strict';

const sel = (id, path, value, opts, empty) => `<select id="${id}" data-bind="${path}">${empty ? `<option value="">${esc(empty)}</option>` : ''}${opts.map(([v, l]) => `<option value="${esc(v)}" ${String(value) === String(v) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
const paras = t => String(t || '').split(/\n{2,}/).map(p => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('');
/* A character's seat: in the series being shown if they have one there, otherwise wherever they race. */
function charSeat(charId) { return F1.seats().find(s => s.holderCharId === charId) || list('f1_seats').find(s => s.holderCharId === charId) || null; }
function charLine(c) {
  if (!c) return '';
  const s = charSeat(c.id), t = s ? F1.team(s.teamId) : null;
  return t ? `${seatTitle(s).toLowerCase()}, ${t.name}` : charRoleName(c.role).toLowerCase();
}

/* ---------------------------------------------------------------- car performance (Race Control) */
const CAR_FIELDS = [['carPace', 'Overall pace', 50, 99], ['topSpeed', 'Top speed (5 to 20)', 1, 25], ['cornering', 'Cornering (5 to 20)', 1, 25],
  ['reliability', 'Reliability', 40, 99], ['tyreLife', 'Kindness to tyres', 40, 99], ['pitSpeed', 'Pit crew speed', 50, 99]];
ACTIONS['car-edit'] = d => { const t = get('f1_teams', d.id); if (!t) return; S.ui.form.car = Object.assign(clone(S.store.f1_teams[d.id]), { id: d.id }); openDrawer('car'); };
DRAWERS.car = function () {
  const f = S.ui.form.car || {};
  const num = ([k, l, min, max]) => `<label class="field">${l}<input id="car-${k}" type="number" min="${min}" max="${max}" data-bind="ui/form/car/${k}" data-type="number" value="${esc(f[k] == null ? '' : f[k])}"></label>`;
  const arch = FormulaRacingAdapter.ARCHETYPES;
  return `<header><div><h2>${esc(f.name || '')}: the car</h2><p>These numbers decide the team’s pace and reliability in every session. Changes apply from the next qualifying.</p></div>
    <button class="btn ghost" data-act="close-drawer">Close</button></header>
    <div class="body"><div class="form-grid">
      <label class="field">Team name<input id="car-name" type="text" data-bind="ui/form/car/name" value="${esc(f.name || '')}"></label>
      <label class="field">Power unit<input id="car-pu" type="text" data-bind="ui/form/car/powerUnit" value="${esc(f.powerUnit || '')}"></label>
      <label class="field">Team colour<input id="car-color" type="color" data-bind="ui/form/car/color" value="${esc(f.color || '#888888')}"></label>
      <label class="field">AI strategist’s habit${sel('car-strategy', 'ui/form/car/strategy', f.strategy, Object.keys(arch).map(k => [k, arch[k].label]))}</label>
      ${CAR_FIELDS.map(num).join('')}
    </div>
    <div class="btn-row"><button class="btn primary" data-act="car-save">Save the car</button></div></div>`;
};
ACTIONS['car-save'] = () => {
  const f = clone(S.ui.form.car || {}), id = f.id; delete f.id; if (!id) return;
  const bad = CAR_FIELDS.find(([k, , min, max]) => !(f[k] >= min && f[k] <= max));
  if (bad) { toast(`${bad[1]} must be between ${bad[2]} and ${bad[3]}.`, true); return; }
  run(async () => { await Data.put('f1_teams', id, f); await Data.audit('car.update', `${f.name}: car performance updated`); closeDrawer(); }, 'Car saved.');
};

/* ---------------------------------------------------------------- Discord */
ACTIONS['f1-discord'] = d => {
  const w = get('f1_weekends', d.id); if (!w || !w.results) return;
  const t = F1.track(w.trackId) || { name: w.trackId }, win = w.results[0] || {};
  run(async () => {
    const api = await window.claude.use('discord');
    let channel = 'default';
    try { const ch = (await api.channels()).map(c => typeof c === 'string' ? c : c.name); channel = ch.indexOf('results') !== -1 ? 'results' : ch.indexOf('default') !== -1 ? 'default' : (ch[0] || 'default'); } catch (e) { throw e; }
    const lines = w.results.slice(0, 10).map(r => `**${r.position || 'DNF'}.** ${r.name}, ${F1.team(r.teamId).name}${r.points ? ` (${r.points} pts)` : ''}`);
    const fast = w.state && w.state.fastest ? (w.entrants || []).find(e => e.id === w.state.fastest.id) : null;
    await api.post({ channel, payload: { embeds: [{
      title: `${t.flag || ''} ${t.name}${w.session === 'sprint' ? ' Sprint' : ''}: result`.trim(),
      description: lines.join('\n') + (fast ? `\n\nFastest lap: ${fast.name}, ${f1Fmt(w.state.fastest.time)}` : ''),
      color: parseInt(String(f1Colour(win.teamId)).replace('#', ''), 16) || 0xE10600, footer: { text: 'F1 SIM' } }] } });
    await Data.audit('discord.result', `${t.name} result posted to Discord (${channel})`);
  }, 'Result posted to Discord.');
};

/* ---------------------------------------------------------------- Paddock: news, interviews and paddock life */
const POST_KINDS = [['news', 'News'], ['interview', 'Interview'], ['life', 'Paddock life']];
const postKind = k => (POST_KINDS.find(p => p[0] === k) || [k, k])[1];
ACTIONS['post-new'] = d => {
  const c = currentChar(); if (!c) { toast('Create a character first, on Your characters.', true); return; }
  S.ui.form.post = { kind: d.kind || (c.role === 'media' ? 'news' : 'life'), title: '', body: '', weekendId: '' }; openDrawer('post');
};
ACTIONS['post-edit'] = d => { const p = get('f1_posts', d.id); if (!p) return; S.ui.form.post = Object.assign(clone(S.store.f1_posts[d.id]), { id: d.id }); openDrawer('post'); };
DRAWERS.post = function () {
  const f = S.ui.form.post || {}, c = f.id ? get('characters', f.charId) : currentChar();
  const weekends = F1.weekends().filter(w => w.status !== 'practice').slice(0, 8);
  return `<header><div><h2>${f.id ? 'Edit post' : 'Write for the paddock'}</h2><p>Posting as ${esc(c ? c.name : 'your character')}${c ? ', ' + esc(charLine(c)) : ''}.</p></div>
    <button class="btn ghost" data-act="close-drawer">Close</button></header>
    <div class="body"><div class="form-grid">
      <label class="field">Kind of post${sel('post-kind', 'ui/form/post/kind', f.kind, POST_KINDS)}</label>
      <label class="field">About a race weekend (optional)${sel('post-weekend', 'ui/form/post/weekendId', f.weekendId || '', weekends.map(w => [w.id, ((F1.track(w.trackId) || {}).name || w.trackId) + (w.session === 'sprint' ? ' sprint' : '')]), 'None')}</label>
    </div>
    <label class="field">Headline<input id="post-title" type="text" data-bind="ui/form/post/title" value="${esc(f.title || '')}" placeholder="${f.kind === 'life' ? 'e.g. Rain delay, so the garage ordered pizza' : 'e.g. Hart holds off the champion in Interlagos'}"></label>
    <label class="field">${f.kind === 'interview' ? 'The interview' : 'The story'}<textarea id="post-body" rows="12" data-bind="ui/form/post/body" placeholder="Leave a blank line between paragraphs.">${esc(f.body || '')}</textarea></label>
    <p class="muted small">Interviews and quotes are for characters in this league. Real drivers and team principals appear in race results only.</p>
    <div class="btn-row"><button class="btn primary" data-act="post-save">${f.id ? 'Save changes' : 'Publish'}</button></div></div>`;
};
ACTIONS['post-save'] = () => {
  const f = clone(S.ui.form.post || {}), id = f.id || newId('post'); delete f.id;
  f.title = String(f.title || '').trim(); f.body = String(f.body || '').trim();
  if (!f.title || !f.body) { toast('Give the post a headline and some words.', true); return; }
  const prev = get('f1_posts', id), c = prev ? get('characters', prev.charId) : currentChar(); if (!c) return;
  const doc = Object.assign({}, prev ? clone(S.store.f1_posts[id]) : { createdAt: nowIso(), userId: asOwner(), charId: c.id, charName: c.name }, f, prev ? { editedAt: nowIso() } : {});
  run(async () => { await Data.put('f1_posts', id, doc); closeDrawer(); }, prev ? 'Post updated.' : 'Published to the paddock.');
};
ACTIONS['post-delete'] = d => askConfirm('Delete this post? It can’t be brought back.', 'Delete', () => run(async () => { await Data.remove('f1_posts', d.id); }, 'Post deleted.'), true);
ACTIONS['paddock-filter'] = d => { S.ui.padKind = d.kind || ''; render(); };
function postCardHtml(p, short) {
  const c = get('characters', p.charId), s = c ? charSeat(c.id) : null, t = s ? F1.team(s.teamId) : null, w = p.weekendId ? get('f1_weekends', p.weekendId) : null;
  const mine = p.userId === S.uid, body = short && p.body.length > 320 ? p.body.slice(0, 320) + '…' : p.body;
  return `<article class="card post ${esc(p.kind)}" ${t ? `style="--team:${esc(t.color)}"` : ''}>
    <p class="post-meta"><span class="tag ${p.kind === 'life' ? 'life' : ''}">${esc(postKind(p.kind))}</span> ${esc((c && c.name) || p.charName || 'Someone')}${c ? ', ' + esc(charLine(c)) : ''}. ${esc(fmtWhen(p.createdAt))}${w ? `. ${esc((F1.track(w.trackId) || {}).name || '')}` : ''}</p>
    <h2>${esc(p.title)}</h2><div class="post-body">${paras(body)}</div>
    ${!short && (mine || S.isGm) ? `<div class="btn-row">${mine ? `<button class="btn small" data-act="post-edit" data-id="${esc(p.id)}">Edit</button>` : ''}<button class="btn small" data-act="post-delete" data-id="${esc(p.id)}">Delete</button></div>` : ''}
  </article>`;
}
/* Facts for the press: what happened at the latest race, straight from the race record. */
function pressFactsHtml() {
  const w = F1.weekends().find(x => x.status === 'finished'); if (!w) return '';
  const t = F1.track(w.trackId) || {}, r = w.results || [], players = r.filter(x => x.charId);
  const ev = (w.state && w.state.events) || [], dnf = r.filter(x => x.status === 'dnf'), sc = ev.filter(e => e.kind === 'sc' && /deployed/.test(e.text)).length;
  const gain = r.filter(x => x.position).map(x => ({ x, g: x.grid - x.position })).sort((a, b) => b.g - a.g)[0];
  return `<aside class="card facts"><h2>Press notes: ${esc(t.name || '')}${w.session === 'sprint' ? ' sprint' : ''}</h2><ul>
    ${r.slice(0, 3).map(x => `<li>P${x.position}: ${esc(x.name)}, ${esc(F1.team(x.teamId).name)}</li>`).join('')}
    ${gain && gain.g > 0 ? `<li>Biggest climb: ${esc(gain.x.name)}, ${gain.g} places from P${gain.x.grid}</li>` : ''}
    ${players.map(x => `<li>${esc(x.name)} (player): ${x.position ? 'P' + x.position : 'out, ' + esc(x.gap || '')}</li>`).join('')}
    <li>${plural(sc, 'safety car')}, ${plural(dnf.length, 'retirement')}</li></ul>
    <button class="btn small" data-act="f1-view" data-id="${esc(w.id)}" data-go="weekend">Full race record</button></aside>`;
}
ACTIONS['f1-view'] = d => { S.ui.f1view = d.id || null; if (d.go) go(d.go); else render(); };
route('paddock', 'Paddock', function () {
  const k = S.ui.padKind || '', posts = list('f1_posts').filter(p => !k || p.kind === k).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const c = currentChar();
  const tabs = [['', 'Everything']].concat(POST_KINDS).map(([v, l]) => `<button class="btn small" data-act="paddock-filter" data-kind="${v}" aria-pressed="${k === v}">${l}</button>`).join('');
  return `<div class="page-head"><div><h1>Paddock</h1><p>The league’s own press and its life off track: race reports and interviews from the media, and everyday stories from everyone else.</p></div>
      ${c ? `<div class="btn-row"><button class="btn primary" data-act="post-new">${icon('plus', 16)} Write as ${esc(c.name.split(' ')[0])}</button></div>` : ''}</div>
    <div class="paddock"><div><div class="btn-row filters" role="group" aria-label="Show">${tabs}</div>
      ${posts.length ? posts.map(p => postCardHtml(p)).join('') : `<div class="card empty-card"><h2>Nothing here yet</h2><p>${c ? 'Be the first: a race report, an interview with a team-mate, or a day in the life of the garage.' : 'Create a character to start writing.'}</p></div>`}</div>
      ${pressFactsHtml()}</div>`;
});

/* ---------------------------------------------------------------- Home */
route('home', 'Home', function () {
  const c = currentChar(), a = ACCOUNT();
  const teams = F1.teams();
  if (!teams.length) return `<div class="page-head"><div><h1>Welcome to the paddock</h1><p>${S.isGm ? 'Start by loading today’s grid.' : 'Race Control is setting up the grid.'}</p></div></div>
    ${S.isGm ? `<div class="card empty-card"><h2>Set up the league</h2><p>Load today’s grid: 11 teams, their real drivers and team principals, and 23 circuits. Players’ characters then take seats in place of the real people.</p><button class="btn primary" data-act="f1-load">Load today’s grid</button></div>` : ''}
    ${!c ? charPromptHtml() : ''}`;
  const live = F1.live(), last = F1.weekends().find(w => w.status === 'finished'), next = f1NextTrack();
  const seat = c ? charSeat(c.id) : null, team = seat ? F1.team(seat.teamId) : null;
  const apps = c ? list('f1_applications').filter(x => x.charId === c.id).sort((x, y) => String(y.createdAt).localeCompare(String(x.createdAt))) : [];
  const st = f1Standings(), posts = list('f1_posts').sort((x, y) => String(y.createdAt).localeCompare(String(x.createdAt))).slice(0, 3);
  const liveTrack = live ? F1.track(live.trackId) : null;
  const weekendCard = live ? `<section class="card hero-race" style="--team:${esc(f1Colour((last && last.results && last.results[0] || {}).teamId))}">
      <p class="eyebrow">Round ${esc(liveTrack.round)}${live.session === 'sprint' ? ', sprint' : ''}</p><h2>${esc(liveTrack.flag || '')} ${esc(liveTrack.name)}</h2>
      <p>${live.status === 'practice' ? 'Practice: teams are sending set-ups.' : live.status === 'grid' ? 'Qualifying is done. The grid is set.' : `Lap ${live.state.lap} of ${live.state.laps}.`}</p>
      <button class="btn primary" data-act="nav" data-route="weekend">${seat ? 'Go to your pit wall' : 'Watch the timing'}</button></section>`
    : `<section class="card hero-race"><p class="eyebrow">Next up</p><h2>${next ? esc((next.flag || '') + ' ' + next.name) : 'No races yet'}</h2>
      <p>${next ? `Round ${next.round}, ${esc(next.circuit)}, ${next.laps} laps.` : ''} ${S.isGm ? 'Open the weekend when you’re ready.' : 'Race Control opens the weekend.'}</p>
      <button class="btn" data-act="nav" data-route="weekend">Race Weekend</button></section>`;
  const you = c ? `<section class="card" ${team ? `style="--team:${esc(team.color)}"` : ''}><h2>${esc(c.name)}</h2>
      <p>${seat ? `<b>${esc(seatTitle(seat))}, ${esc(team.name)}</b>${f1Occupant(seat).real ? `, in place of ${esc(f1Occupant(seat).real.name)}` : ''}.` : esc(charRoleName(c.role)) + ', without a seat.'}</p>
      ${charStatus(c) !== 'approved' ? `<p>Application: <b>${esc(STATUS_TEXT[charStatus(c)].toLowerCase())}</b>. <button class="btn small" data-act="char-open" data-id="${esc(c.id)}">Open it</button></p>` : ''}
      ${f1ContractOffersFor(c.id).length ? `<p><b>${plural(f1ContractOffersFor(c.id).length, 'contract offer')}</b> waiting. <button class="btn small" data-act="char-open" data-id="${esc(c.id)}">See the offer</button></p>` : ''}
      ${apps.slice(0, 3).map(x => `<p class="small">Application for ${esc(seatTitle(get('f1_seats', x.seatId) || { role: x.role, car: '' }).toLowerCase())} at ${esc(F1.team(x.teamId).name)} (${esc(seriesDoc((get('f1_teams', x.teamId) || {}).seriesId || 'f1').short)}): <b>${x.status === 'pending' ? 'waiting for Race Control' : x.status}</b></p>`).join('')}
      ${!seat && (c.role === 'driver' || c.role === 'principal' || c.role === 'engineer') ? '<button class="btn small" data-act="nav" data-route="grid">Find an open seat</button>' : ''}</section>` : charPromptHtml();
  const result = last ? `<section class="card"><h2>Latest result: ${esc((F1.track(last.trackId) || {}).name || '')}${last.session === 'sprint' ? ' sprint' : ''}</h2>
      <ol class="podium">${(last.results || []).slice(0, 3).map(r => `<li style="--team:${esc(f1Colour(r.teamId))}"><b>${esc(r.name)}</b><span>${esc(F1.team(r.teamId).name)}</span></li>`).join('')}</ol>
      <button class="btn small" data-act="f1-view" data-id="${esc(last.id)}" data-go="weekend">Full result</button></section>` : '';
  const table = st.drivers.length ? `<section class="card"><h2>Championship</h2><table class="data compact"><tbody>${st.drivers.slice(0, 5).map((d, i) =>
      `<tr${d.charId && d.charId === S.charId ? ' class="me"' : ''}><td>${i + 1}</td><td><span class="f1-bar" style="background:${esc(f1Colour(d.teamId))}"></span>${esc(d.name)}</td><td class="num"><b>${d.pts}</b></td></tr>`).join('')}</tbody></table>
      <button class="btn small" data-act="nav" data-route="standings">Full standings</button></section>` : '';
  return `<div class="page-head"><div><p class="eyebrow">${esc(curSeries().name)}, ${esc(curSeason().name)} season</p><h1>${c ? 'Welcome back, ' + esc(c.name.split(' ')[0]) : 'Welcome' + (a ? ', ' + esc(a.username) : '')}</h1></div></div>
    <div class="home">${weekendCard}${you}${result}${table}
      ${posts.length ? `<section class="home-posts"><h2>From the paddock</h2>${posts.map(p => postCardHtml(p, true)).join('')}<button class="btn small" data-act="nav" data-route="paddock">More in Paddock</button></section>` : ''}</div>`;
});
function charPromptHtml() {
  return `<section class="card empty-card"><h2>Create your character</h2><p>A driver, team principal, race engineer, journalist, or someone living the paddock life. Race Control can put them into a seat, or they can apply for an open one.</p>
    <button class="btn primary" data-act="char-new">Create a character</button></section>`;
}

/* ---------------------------------------------------------------- Race Control desk */
route('control', 'Race Control', function () {
  const apps = list('f1_applications').sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const pending = apps.filter(a => a.status === 'pending'), decided = apps.filter(a => a.status !== 'pending').slice(0, 10);
  const chars = list('characters').filter(c => !c.retired).sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const audit = list('audit').sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 60);
  const appCard = a => { const s = get('f1_seats', a.seatId), c = get('characters', a.charId), o = s ? f1Occupant(s) : null, t = F1.team(a.teamId);
    const ser = seriesDoc((get('f1_teams', a.teamId) || {}).seriesId || 'f1');
    return `<article class="card" style="--team:${esc(t.color)}"><p class="eyebrow">${esc(ser.name)}</p><h3>${esc(a.charName)} for ${esc(s ? seatTitle(s).toLowerCase() : a.role)} at ${esc(t.name)}</h3>
      <p class="muted small">Sent ${esc(fmtWhen(a.createdAt))}. ${o ? `The seat is held by ${esc(o.name)}${o.player ? ' (a player)' : ''}.` : ''}</p>
      ${a.note ? paras(a.note) : '<p class="muted">No note.</p>'}
      ${c && c.bio ? `<details><summary>About ${esc(c.name)}</summary>${paras(c.bio)}</details>` : ''}
      <div class="btn-row"><button class="btn primary" data-act="app-decide" data-id="${esc(a.id)}" data-ok="1">Give them the seat</button><button class="btn" data-act="app-decide" data-id="${esc(a.id)}" data-ok="0">Decline</button></div></article>`; };
  return `<div class="page-head"><div><h1>Race Control</h1><p>Character applications, seat applications, the people in the paddock, and a record of everything Race Control and the teams have done. Use View as in the top bar to see the league as any character.</p></div></div>
    ${noticeComposerHtml()}
    ${leaguePanelHtml()}
    ${chargenQueueHtml()}
    <section><h2 class="section-h">Seat applications ${pending.length ? `<span class="count">${pending.length}</span>` : ''}</h2>
      ${pending.length ? `<div class="cards">${pending.map(appCard).join('')}</div>` : '<p class="muted">No applications waiting. Open seats on The Grid to take applications.</p>'}
      ${decided.length ? `<details class="card"><summary>Recently decided</summary><table class="data"><tbody>${decided.map(a => `<tr><td>${esc(a.charName)}</td><td>${esc(F1.team(a.teamId).name)}</td><td>${esc(a.status)}</td><td>${esc(fmtDate(a.decidedAt))}</td></tr>`).join('')}</tbody></table></details>` : ''}</section>
    <section class="card"><h2>Characters</h2>${chars.length ? `<div class="scroll-x"><table class="data"><thead><tr><th>Name</th><th>What they do</th><th>Seat</th><th>Discord</th></tr></thead><tbody>${chars.map(c => { const s = charSeat(c.id);
        return `<tr><td><b>${esc(c.name)}</b>${c.code ? ` <span class="muted">${esc(c.code)}</span>` : ''}</td><td>${esc(charRoleName(c.role))}</td><td>${s ? esc(seatTitle(s) + ', ' + F1.team(s.teamId).name) : '<span class="muted">None</span>'}</td><td>${esc(c.discord || '')}</td></tr>`; }).join('')}</tbody></table></div>` : '<p class="muted">No characters yet.</p>'}</section>
    <section class="card"><h2>Audit record</h2>${audit.length ? `<div class="scroll-x"><table class="data compact"><tbody>${audit.map(x => `<tr><td class="nowrap">${esc(fmtWhen(x.at))}</td><td>${esc(x.actor || '')}</td><td>${esc(x.summary || x.action)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">Nothing recorded yet.</p>'}</section>`;
}, { gm: true });

/* ---------------------------------------------------------------- Accounts and backups (Administrator) */
async function loadMembers() {
  const a = ACCOUNT(); if (!a || !a.listMembers) { S.ui.members = []; S.ui.membersErr = 'Accounts are managed in Supabase in this set-up.'; render(); return; }
  try { S.ui.members = await a.listMembers(); S.ui.membersErr = null; } catch (e) { S.ui.membersErr = e.message || 'Couldn’t load the accounts.'; }
  render();
}
CHANGES['member-role'] = (v, d) => run(async () => { await ACCOUNT().setRole(d.id, v, []); await Data.audit('account.role', `${d.name} is now ${v === 'mod' ? 'Race Control' : 'a player'}`); await loadMembers(); }, 'Role changed.');
ACTIONS['member-reset'] = d => { const p = String((S.ui.form.pw || {})[d.id] || ''); if (p.length < 8) { toast('Type a new password of at least 8 characters first.', true); return; }
  run(async () => { await ACCOUNT().resetPassword(d.id, p); S.ui.form.pw[d.id] = ''; await Data.audit('account.password', `Password reset for ${d.name}`); }, `Password reset. Give ${d.name} the new one privately.`); };
ACTIONS['member-delete'] = d => askConfirm(`Delete the account ${d.name}? Their characters stay in the league until you retire them.`, 'Delete the account', () => run(async () => { await ACCOUNT().deleteAccount(d.id); await Data.audit('account.delete', `Account ${d.name} deleted`); await loadMembers(); }, 'Account deleted.'), true);
/* Invite codes: always needed for new accounts, generated by the system, shown once. */
async function loadInviteStatus() { const a = ACCOUNT(); if (!a || !a.inviteStatus) { S.ui.inviteStatus = { issued: false, na: true }; render(); return; }
  try { S.ui.inviteStatus = await a.inviteStatus(); } catch (e) { S.ui.inviteStatus = { issued: false, err: e.message || String(e) }; } render(); }
ACTIONS['invite-gen'] = () => { const st = S.ui.inviteStatus || {};
  askConfirm(st.issued ? 'Generate a new invite code? The current code stops working straight away; anyone who hasn’t signed up yet will need the new one.' : 'Generate an invite code? New accounts will need it to sign up.', 'Generate', () => run(async () => {
    S.ui.inviteNew = await ACCOUNT().generateInviteCode(); await loadInviteStatus(); await Data.audit('account.invite', 'A new invite code was generated'); }, 'New invite code ready. Copy it now: it won’t be shown again.')); };
ACTIONS['invite-close'] = () => askConfirm('Close sign-ups? The current invite code stops working and nobody can create an account until you generate a new one. Existing players sign in as normal.', 'Close sign-ups', () => run(async () => {
  await ACCOUNT().setInviteCode(null); S.ui.inviteNew = null; await loadInviteStatus(); await Data.audit('account.invite', 'Sign-ups closed: invite code removed'); }, 'Sign-ups closed.'), true);
ACTIONS['invite-copy'] = () => { const c = S.ui.inviteNew; if (!c) return; (navigator.clipboard ? navigator.clipboard.writeText(c) : Promise.reject()).then(() => toast('Copied.'), () => toast('Select the code and copy it.', true)); };
ACTIONS['invite-hide'] = () => { S.ui.inviteNew = null; render(); };
function inviteCardHtml() {
  if (S.ui.inviteStatus === undefined) { S.ui.inviteStatus = null; setTimeout(loadInviteStatus, 0); }
  const st = S.ui.inviteStatus, code = S.ui.inviteNew;
  const status = st === null ? '<p class="muted">Checking…</p>' : st.err ? `<p class="bad-text">${esc(st.err)}</p>` : st.na ? '<p class="muted">Invite codes are managed in Supabase in this set-up.</p>'
    : st.issued ? `<p><span class="tag player">Open</span> An invite code is active${st.at ? `, generated ${esc(fmtWhen(st.at))}` : ''}. New accounts need it; existing players sign in as normal.</p>`
    : '<p><span class="tag flag">Closed</span> No invite code: nobody can create an account. Generate one to let new players join.</p>';
  return `<section class="card invite-card"><h2>Invite code</h2>
    <p class="muted small">Every new account needs the invite code. The system makes it: 10 letters and numbers, with no O, 0, I or 1 to mix up. Only a scrambled copy is stored, so it’s shown once, when it’s made.</p>${status}
    ${code ? `<div class="invite-new"><span class="muted small">The new code, shown once</span><code class="invite-code" aria-label="Invite code ${esc(code.split('').join(' '))}">${esc(code)}</code>
      <div class="btn-row"><button class="btn primary" data-act="invite-copy">Copy</button><button class="btn ghost" data-act="invite-hide">I’ve saved it</button></div>
      <p class="muted small">Share it privately, such as in a direct message or a private Discord channel. Anyone with it can create an account.</p></div>` : ''}
    <div class="btn-row"><button class="btn ${code ? '' : 'primary'}" data-act="invite-gen">${st && st.issued ? 'Generate a new code' : 'Generate a code'}</button>${st && st.issued ? '<button class="btn ghost" data-act="invite-close">Close sign-ups</button>' : ''}</div></section>`;
}
ACTIONS['backup'] = () => {
  const out = { app: 'F1 SIM', exportedAt: nowIso(), collections: {} };
  COLLECTIONS.forEach(c => { out.collections[c] = clone(S.store[c] || {}); });
  const name = `f1-sim-backup-${new Date().toISOString().slice(0, 10)}.json`, data = JSON.stringify(out, null, 1);
  Promise.resolve(window.claude.use('downloads')).then(d => d.save({ filename: name, data })).catch(() => {
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([data], { type: 'application/json' })); a.download = name; document.body.appendChild(a); a.click(); a.remove(); });
  toast('Backup downloaded. Keep it somewhere safe, not in the repository.');
};
CHANGES['restore'] = (v, d, el) => {
  const file = el.files && el.files[0]; if (!file) return;
  file.text().then(t => {
    let j; try { j = JSON.parse(t); } catch (e) { toast('That file isn’t a backup: it isn’t valid JSON.', true); return; }
    if (!j || j.app !== 'F1 SIM' || !j.collections) { toast('That file isn’t an F1 SIM backup.', true); return; }
    const rows = []; Object.keys(j.collections).filter(c => COLLECTIONS.indexOf(c) !== -1).forEach(c => Object.keys(j.collections[c]).forEach(id => rows.push({ collection: c, id, data: j.collections[c][id] })));
    askConfirm(`Restore ${plural(rows.length, 'record')} from ${fmtDate(j.exportedAt)}? Records with the same names are replaced; nothing else is deleted.`, 'Restore', () => run(async () => {
      const a = ACCOUNT();
      if (a && a.bulkPut) await a.bulkPut(rows); else for (const r of rows) await Data.put(r.collection, r.id, r.data);
      rows.forEach(r => { (S.store[r.collection] = S.store[r.collection] || {})[r.id] = r.data; });
      await Data.audit('backup.restore', `Restored ${rows.length} records from a backup`);
    }, 'Backup restored.'));
  });
  el.value = '';
};
route('admin', 'Accounts and backups', function () {
  if (S.ui.members === undefined) { S.ui.members = null; setTimeout(loadMembers, 0); }
  const ms = S.ui.members, pw = S.ui.form.pw = S.ui.form.pw || {};
  const rows = (ms || []).map(m => { const self = m.user_id === S.uid, name = m.username;
    return `<tr><td><b>${esc(name)}</b>${self ? ' <span class="tag you">You</span>' : ''}</td><td>${m.role === 'owner' ? 'Administrator' : self ? (m.role === 'mod' ? 'Race Control' : 'Player')
      : `<label class="sr-only" for="role-${esc(m.user_id)}">Role for ${esc(name)}</label><select id="role-${esc(m.user_id)}" data-change="member-role" data-id="${esc(m.user_id)}" data-name="${esc(name)}"><option value="player" ${m.role === 'player' ? 'selected' : ''}>Player</option><option value="mod" ${m.role === 'mod' || m.role === 'gm' ? 'selected' : ''}>Race Control</option></select>`}</td>
      <td>${list('characters').filter(c => c.userId === m.user_id && !c.retired).map(c => esc(c.name)).join(', ') || '<span class="muted">None</span>'}</td>
      <td class="nowrap">${esc(fmtDate(m.created_at))}</td>
      <td>${self || m.role === 'owner' ? '' : `<div class="btn-row"><label class="sr-only" for="pw-${esc(m.user_id)}">New password for ${esc(name)}</label><input id="pw-${esc(m.user_id)}" type="text" autocomplete="off" placeholder="New password" data-bind="ui/form/pw/${esc(m.user_id)}" value="${esc(pw[m.user_id] || '')}" style="max-width:160px">
        <button class="btn small" data-act="member-reset" data-id="${esc(m.user_id)}" data-name="${esc(name)}">Reset password</button><button class="btn small danger" data-act="member-delete" data-id="${esc(m.user_id)}" data-name="${esc(name)}">Delete</button></div>`}</td></tr>`; }).join('');
  return `<div class="page-head"><div><h1>Accounts and backups</h1><p>Who can sign in, who runs Race Control, and copies of the league’s records.</p></div></div>
    <section class="card"><h2>Accounts</h2>${S.ui.membersErr ? `<p class="bad-text">${esc(S.ui.membersErr)}</p>` : ms === null ? '<p class="muted">Loading the accounts…</p>'
      : `<div class="scroll-x"><table class="data"><thead><tr><th>Username</th><th>Role</th><th>Characters</th><th>Joined</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`}
      <p class="muted small">Race Control can run weekends, fill seats and tune cars. Only the Administrator changes roles.</p></section>
    ${inviteCardHtml()}
    <section class="card"><h2>Backups</h2><p>The free Supabase plan has no automatic backups. Download one every few race weekends.</p>
      <div class="btn-row"><button class="btn primary" data-act="backup">Download a backup</button>
        <label class="btn file-btn">Restore a backup<input type="file" accept="application/json,.json" data-change="restore" class="sr-only"></label></div></section>`;
}, { gm: true, owner: true });

/* =====================================================================
   F1 SIM — team preference, wins and podiums by championship, and what
   new players see.
   Drivers, race engineers and team principals pick the team they'd like
   to join (a first and second choice, why, or any team) on their
   application; Race Control sees it when reviewing and makes the call.
   Every character page shows wins and podiums by championship: F1 SIM
   races counted automatically, other series from canon career seasons.
   Players without an approved character see only Home, The Grid, the
   Calendar, the Championship, Seasons and Your characters.
   ===================================================================== */
'use strict';

/* ---------------------------------------------------------------- team preference */
const PREF_ROLES = ['driver', 'engineer', 'principal'];
const prefOf = c => (c && c.teamPref) || {};
const prefEditable = c => !!c && (c.userId === S.uid || S.isGm) && ['draft', 'returned', 'pending'].indexOf(charStatus(c)) !== -1;
function prefSeriesId(c) { const p = prefOf(c); return S.ui.prefSeries || (p.first ? ((get('f1_teams', p.first) || {}).seriesId || 'f1') : curSeriesId()); }
function savePref(c, patch, msg) { const doc = charDoc(c.id); doc.teamPref = Object.assign({}, prefOf(doc), patch, { at: nowIso() }); return run(async () => { await Data.put('characters', c.id, doc); }, msg); }
ACTIONS['tp-first'] = d => { const c = get('characters', S.ui.charEdit); if (!prefEditable(c)) return; const p = prefOf(c);
  savePref(c, Object.assign({ first: d.team, any: false }, p.second === d.team ? { second: '' } : {})); };
CHANGES['tp-second'] = v => { const c = get('characters', S.ui.charEdit); if (prefEditable(c)) savePref(c, { second: v }); };
CHANGES['tp-why'] = v => { const c = get('characters', S.ui.charEdit); if (prefEditable(c)) savePref(c, { why: String(v || '').trim().slice(0, 200) }); };
CHANGES['tp-any'] = (v, d, el) => { const c = get('characters', S.ui.charEdit); if (prefEditable(c)) savePref(c, { any: !!(el && el.checked) }); };
CHANGES['tp-series'] = v => { S.ui.prefSeries = v; render(); };
const teamName = id => (get('f1_teams', id) || {}).name || '';
function prefLine(c) {
  const p = prefOf(c); if (PREF_ROLES.indexOf(c.role) === -1) return '';
  if (!p.first && !p.second) return p.any ? 'Happy to go to any team.' : '';
  return `Wants: ${[p.first ? `${teamName(p.first)} (first choice)` : '', p.second ? `${teamName(p.second)} (second)` : ''].filter(Boolean).join(', ')}${p.any ? ', or any team' : ''}.${p.why ? ` “${p.why}”` : ''}`;
}
const prefDone = c => PREF_ROLES.indexOf(c.role) === -1 || !!(prefOf(c).first || prefOf(c).any);
function teamPrefHtml(c) {
  if (PREF_ROLES.indexOf(c.role) === -1) return '';
  const p = prefOf(c), can = prefEditable(c);
  if (!can) return prefLine(c) ? `<section class="card"><h2>Team you’d like to join</h2><p>${esc(prefLine(c))}</p></section>` : '';
  const sid = prefSeriesId(c), teams = list('f1_teams').filter(t => (t.seriesId || 'f1') === sid).sort((a, b) => (a.order || 0) - (b.order || 0));
  const seriesList = allSeries().filter(s => list('f1_teams').some(t => (t.seriesId || 'f1') === s.id));
  const role = c.role === 'principal' ? 'principal' : c.role === 'engineer' ? 'engineer' : 'driver', roleWord = { driver: 'seats', engineer: 'engineer posts', principal: 'principal post' }[role];
  const card = t => { const seats = list('f1_seats').filter(s => s.teamId === t.id && s.role === role), held = seats.filter(s => s.holderCharId).length;
    return `<button class="card tp-team ${p.first === t.id ? 'on' : ''}" style="--team:${esc(t.color || '#888')}" data-act="tp-first" data-team="${esc(t.id)}" aria-pressed="${p.first === t.id}">
      <b>${esc(t.name)}</b><span class="muted small">${esc(engineLabel(t.id))}. ${seats.length ? (held ? `${held} of ${seats.length} ${roleWord} held by players` : `${seats.length === 1 ? 'Open to players' : `All ${seats.length} ${roleWord} open to players`}`) : ''}</span></button>`; };
  return `<section class="card" id="team-pref"><h2>Team you’d like to join</h2>
    <p>Pick the team you’d most like to join, and a second choice. Race Control makes the final call when they approve you, based on the grid, your background and your story.</p>
    ${seriesList.length > 1 ? `<label class="field" style="max-width:280px">Series<select id="tp-series" data-change="tp-series">${seriesList.map(s => `<option value="${esc(s.id)}" ${s.id === sid ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>` : ''}
    <h3>First choice</h3><div class="tp-grid">${teams.map(card).join('')}</div>
    <div class="form-grid" style="margin-top:14px"><label class="field">Second choice<select id="tp-second" data-change="tp-second"><option value="">None</option>${teams.filter(t => t.id !== p.first).map(t => `<option value="${esc(t.id)}" ${p.second === t.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></label>
      <label class="field">Why this team? (optional)<input id="tp-why" type="text" maxlength="200" data-change="tp-why" value="${esc(p.why || '')}" placeholder="e.g. grew up watching them at Silverstone"></label></div>
    <label class="small"><input id="tp-any" type="checkbox" data-change="tp-any" ${p.any ? 'checked' : ''}> Happy to go to any team</label></section>`;
}

/* ---------------------------------------------------------------- wins and podiums by championship (everyone sees it) */
function winsByChampionship(p, c) {
  const by = new Map(), add = (k, o) => { const x = by.get(k) || { name: k, seasons: 0, titles: 0, wins: 0, podiums: 0, best: 99 }; x.seasons += 1; x.titles += o.t; x.wins += o.w; x.podiums += o.p; x.best = Math.min(x.best, o.b || 99); by.set(k, x); };
  careerRows(c).filter(r => r.status === 'canon').forEach(r => add(seriesLabel(r), { t: String(r.pos) === '1' ? 1 : 0, w: Number(r.wins) || 0, p: Number(r.podiums) || 0, b: Number(r.pos) || 99 }));
  if (p) simSeasons(p.id).forEach(o => add(`F1 SIM: ${o.seriesName}`, { t: o.done && o.pos === 1 ? 1 : 0, w: o.wins, p: o.podiums, b: o.pos }));
  return [...by.values()].sort((a, b) => b.titles - a.titles || b.wins - a.wins || b.podiums - a.podiums);
}
function winsHtml(p, c) {
  const isDriver = p && (!p.kind || p.kind === 'driver');
  if (!isDriver && !careerRows(c).some(r => r.status === 'canon')) return '';
  const rows = winsByChampionship(p, c); if (!rows.length) return '';
  const maxP = Math.max(1, ...rows.map(x => x.podiums)), tot = rows.reduce((s, x) => ({ t: s.t + x.titles, w: s.w + x.wins, p: s.p + x.podiums }), { t: 0, w: 0, p: 0 });
  return `<section class="card wins-champ"><h2>Wins and podiums by championship</h2>
    <div class="metrics"><div class="metric"><b>${tot.t}</b><span>${tot.t === 1 ? 'Title' : 'Titles'}</span></div><div class="metric"><b>${tot.w}</b><span>Wins</span></div><div class="metric"><b>${tot.p}</b><span>Podiums</span></div><div class="metric"><b>${rows.length}</b><span>${rows.length === 1 ? 'Championship' : 'Championships'}</span></div></div>
    <div class="scroll-x"><table class="data"><thead><tr><th>Championship</th><th class="num">Seasons</th><th class="num">Titles</th><th class="num">Wins</th><th class="num">Podiums</th><th class="bars-h">Wins and podiums</th><th>Best finish</th></tr></thead><tbody>
    ${rows.map(x => `<tr><td><b>${esc(x.name)}</b></td><td class="num">${x.seasons}</td><td class="num">${x.titles ? `<span class="tag trophy">${x.titles}</span>` : 0}</td><td class="num">${x.wins}</td><td class="num">${x.podiums}</td>
      <td><div class="wp-bar" role="img" aria-label="${x.wins} wins and ${x.podiums} podiums"><span class="p" style="width:${x.podiums / maxP * 100}%"></span><span class="w" style="width:${x.wins / maxP * 100}%"></span></div></td>
      <td>${x.best === 1 && x.titles ? 'Champion' : x.best < 99 ? ordinal(x.best) : '–'}</td></tr>`).join('')}</tbody></table></div>
    <p class="muted small"><span class="key w"></span> wins <span class="key p"></span> podiums. F1 SIM races count automatically; other championships come from the canon career record.</p></section>`;
}

/* ---------------------------------------------------------------- what players see before approval */
const LIMITED_ROUTES = ['home', 'grid', 'calendar', 'standings', 'seasons', 'characters', 'character', 'career', 'newchar'];
function playerLimited() { return S.phase === 'ready' && !S.isGm && !myChars().some(c => !c.retired && (charStatus(c) === 'approved' || (F1.person(f1PcId(c.id)) || {}).approved)); }
const _navHtmlLimited = navHtml;
navHtml = function () {
  if (!playerLimited()) return _navHtmlLimited();
  const item = ([r, ic, label]) => `<button class="nav-item" data-act="nav" data-route="${r}" ${S.route === r ? 'aria-current="page"' : ''}>${icon(ic)}<span>${esc(label)}</span></button>`;
  let h = `<div class="nav-group">${NAV.filter(x => LIMITED_ROUTES.indexOf(x[0]) !== -1).map(item).join('')}</div>`;
  if (window.F1SIM_VERSION && window.F1SIM_VERSION.indexOf('__') !== 0) h += `<p class="nav-version">F1 SIM v${esc(window.F1SIM_VERSION)}</p>`;
  return h;
};
const _goLimited = go;
go = function (r) { if (playerLimited() && LIMITED_ROUTES.indexOf(r) === -1) { if (ROUTES[r]) toast('That opens once Race Control approves your character.'); r = 'home'; } return _goLimited(r); };
const _homeLimited = ROUTES.home.view;
ROUTES.home.view = function () {
  const h = _homeLimited();
  if (!playerLimited() || S.phase !== 'ready') return h;
  const mine = myChars().filter(c => !c.retired), pend = mine.find(c => charStatus(c) === 'pending');
  return `<section class="card notice limited-note"><h2>Welcome to the paddock</h2><p>${pend ? `${esc(pend.name)}’s application is with Race Control.` : mine.length ? 'Finish your character’s application and send it to Race Control.' : 'Start by creating your character.'} The rest of the site (Team HQ, Race Weekend, the Test Track, Characters and the Paddock) opens once your character is approved.</p>
    <div class="btn-row"><button class="btn primary" data-act="nav" data-route="characters">${mine.length ? 'Your characters' : 'Create a character'}</button></div></section>` + h;
};

/* =====================================================================
   F1 SIM — editing on the application page, and fixing the rolls.
   Details are edited inline on the application page. After rolling, a
   player can change their background or years once: the ratings are
   cleared for a fresh roll. Race Control can give an extra re-roll, or
   reset the ratings (fresh numbers, background and years unlocked, and
   the application reopened if it was sent or approved). Every earlier
   roll is kept, for the player and Race Control to see.
   ===================================================================== */
'use strict';

/* ---------------------------------------------------------------- inline details */
ACTIONS['char-edit-inline'] = d => {
  if (!get('characters', d.id)) return;
  S.ui.form.ch = Object.assign({}, CHAR_BLANK, clone(S.store.characters[d.id]), { id: d.id }); S.ui.charInline = d.id; render();
  setTimeout(() => { const el = document.getElementById('char-inline'); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 60);
};
ACTIONS['char-inline-cancel'] = () => { S.ui.charInline = null; S.ui.form.ch = null; render(); };
function charInlineHtml(c) {
  const f = S.ui.form.ch || {};
  return `<section class="card char-inline" id="char-inline"><h2>Edit details</h2>${charFormFields(f)}
    <div class="btn-row"><button class="btn primary" data-act="char-save">Save changes</button><button class="btn ghost" data-act="char-inline-cancel">Cancel</button></div></section>`;
}
/* The role decides which fields show, so changing it redraws the form wherever it is. */
CHANGES['ch-role'] = v => { if (S.ui.form.ch) { S.ui.form.ch.role = v; renderOverlay(); if (S.ui.charInline || S.route === 'newchar') render(); } };

/* ---------------------------------------------------------------- the rolls */
function genSnapshot(c, by, why) {
  const g = c.gen || {}, rolls = [];
  for (let k = 1; k <= Math.min(g.rolls || 0, maxRolls(c)); k++) { const r = rollValues(c.id, k, g.bracket); if (r) rolls.push({ values: r.values, mental: r.mental, years: r.years, experience: r.experience }); }
  return { at: nowIso(), by, why: why || '', bracket: g.bracket || null, years: g.years || null, rolls, stood: g.rolls ? rolledRatings(c) : null };
}
const freshGen = (g, snap, extraKeep) => ({ style: g.style, salt: (g.salt || 0) + 1, changes: extraKeep.changes, extra: 0, history: (g.history || []).concat([snap]) });
ACTIONS['gen-rechoose'] = () => {
  const c = get('characters', S.ui.charEdit); if (!c || !editable(c)) return; const g = c.gen || {};
  if (!g.rolls) return;
  if ((g.changes || 0) >= 1) { toast('You’ve already changed your background once. Ask Race Control if it needs changing again.', true); return; }
  askConfirm('Change the background or years? Your ratings are cleared and you roll again from the start. You can do this once, and Race Control sees every earlier roll.', 'Change them', () => run(async () => {
    const doc = charDoc(c.id); doc.gen = freshGen(g, genSnapshot(c, 'player', 'Changed background or years'), { changes: (g.changes || 0) + 1 });
    await Data.put('characters', c.id, doc); await Data.audit('character.rechoose', `${c.name} changed background or years after rolling`);
  }, 'Choose the background and years again, then roll.'));
};
const rcNoteFor = id => String(((S.ui.form.rcnote || {})[id]) || '').trim();
ACTIONS['gen-extra'] = d => {
  if (!S.isGm) return; const c = get('characters', d.id || S.ui.charEdit); if (!c) return; const g = c.gen || {}, note = rcNoteFor(c.id);
  run(async () => {
    const doc = charDoc(c.id); doc.gen = Object.assign({}, g, { extra: (g.extra || 0) + 1 });
    if (charStatus(c) === 'pending') Object.assign(doc, { status: 'returned', decidedAt: nowIso(), rcNote: `Race Control has given you an extra re-roll.${note ? ' ' + note : ''}` });
    await Data.put('characters', c.id, doc); await Data.audit('character.extra-roll', `${c.name} given an extra re-roll${note ? ': ' + note : ''}`);
  }, `${c.name} has an extra re-roll.`);
};
ACTIONS['gen-reset'] = d => {
  if (!S.isGm) return; const c = get('characters', d.id || S.ui.charEdit); if (!c) return; const g = c.gen || {}, note = rcNoteFor(c.id), st = charStatus(c);
  askConfirm(`Reset ${c.name}’s ratings? The rolls are cleared and their background and years unlocked, so they roll again with fresh numbers.${st === 'approved' ? ' Their application reopens, and their current ratings stay until you approve it again.' : ''}`, 'Reset the ratings', () => run(async () => {
    const doc = charDoc(c.id); doc.gen = freshGen(g, genSnapshot(c, 'Race Control', note || 'Ratings reset'), { changes: 0 });
    if (st === 'pending' || st === 'approved') Object.assign(doc, { status: 'returned', decidedAt: nowIso(), rcNote: `Race Control reset your ratings: choose your background and years, then roll again.${note ? ' ' + note : ''}` });
    await Data.put('characters', c.id, doc); await Data.audit('character.reset-ratings', `${c.name}: ratings reset by Race Control${note ? ': ' + note : ''}`);
  }, 'Ratings reset.'), true);
};
function rollsHistoryHtml(c) {
  const h = (c.gen || {}).history || []; if (!h.length) return '';
  return `<details class="gen-history"><summary>Earlier attempts (${h.length})</summary>${h.slice().reverse().map(x => { const b = bracketOf(x.bracket), y = yearsOf(x.years);
    return `<div class="gen-attempt"><p class="small"><b>${esc(fmtWhen(x.at))}</b>: ${esc(x.by === 'player' ? 'changed by the player' : 'reset by Race Control')}${x.why && x.by !== 'player' ? `, “${esc(x.why)}”` : ''}. ${esc(b ? b.name : 'No background')}, ${esc(y ? y.label : 'no years chosen')}.</p>
      ${x.rolls.length ? `<table class="data compact"><thead><tr><th></th>${ROLL_ATTRS.map(([, l]) => `<th class="num">${esc(l)}</th>`).join('')}<th class="num">Mental</th></tr></thead><tbody>${x.rolls.map((r, i) => `<tr${i === x.rolls.length - 1 ? ' class="me"' : ''}><td>Roll ${i + 1}${i === x.rolls.length - 1 ? ' (stood)' : ''}</td>${r.values.map(v => `<td class="num">${v}</td>`).join('')}<td class="num">${r.mental}</td></tr>`).join('')}</tbody></table>` : '<p class="muted small">Not rolled.</p>'}</div>`; }).join('')}</details>`;
}
/* Cards on the application page: change background (player), earlier attempts, and Race Control's controls. */
function genFixHtml(c) {
  if (c.role !== 'driver') return '';
  const g = c.gen || {}, ed = editable(c), own = c.userId === S.uid || S.isGm; let h = '';
  if (ed && g.rolls) h += `<section class="card"><h2>Wrong background or years?</h2>${(g.changes || 0) < 1
    ? `<p>You can change them once. Your ratings are cleared for a fresh roll, and Race Control sees every earlier roll.</p><div class="btn-row"><button class="btn" data-act="gen-rechoose">Change background or years</button></div>`
    : '<p class="muted">You’ve already changed them once. Ask Race Control if they need changing again.</p>'}${own ? rollsHistoryHtml(c) : ''}</section>`;
  else if (own && (g.history || []).length) h += `<section class="card"><h2>Earlier attempts</h2>${rollsHistoryHtml(c)}</section>`;
  if (S.isGm && charStatus(c) !== 'pending') h += `<section class="card rc-gen"><h2>Race Control: ratings</h2><p class="small">${g.rolls ? `Roll ${g.rolls} of ${maxRolls(c)}` : 'Not rolled yet'}${g.extra ? `, including ${plural(g.extra, 'extra re-roll')}` : ''}. Background changed by the player: ${g.changes ? 'yes' : 'no'}.</p>
    <label class="field">Note to the player (optional)<textarea id="rcg-${esc(c.id)}" rows="2" data-bind="ui/form/rcnote/${esc(c.id)}"></textarea></label>
    <div class="btn-row"><button class="btn" data-act="gen-extra" data-id="${esc(c.id)}">Give an extra re-roll</button><button class="btn" data-act="gen-reset" data-id="${esc(c.id)}">Reset the ratings</button></div></section>`;
  return h;
}
const _characterViewRegen = ROUTES.character.view;
ROUTES.character.view = function () {
  const h = _characterViewRegen(), c = get('characters', S.ui.charEdit); if (!c) return h;
  const add = genFixHtml(c); if (!add) return h;
  const marks = ['<section class="card" id="team-pref">', '<section class="card"><h2>Team you’d like to join</h2>', '<section class="card"><h2>Send to Race Control</h2>', '<section class="card"><h2>With Race Control</h2>', '<section class="card"><h2>Your driver’s record</h2>'];
  const at = marks.map(m => h.indexOf(m)).filter(i => i >= 0).sort((a, b) => a - b)[0];
  return at == null ? h + add : h.slice(0, at) + add + h.slice(at);
};

/* =====================================================================
   F1 SIM — approvals.
   On the Race Control page, waiting applications (and approved
   characters with career seasons to check) sit as compact rows; clicking
   one opens the full application, where Race Control decides: a summary,
   the note to the player, the acceptance post, Approve or Return, and
   for drivers an extra re-roll or a reset. Career seasons are marked
   canon or not canon right in the application's career record.
   ===================================================================== */
'use strict';

const thumbOf = c => c.portraitUrl ? `<img src="${esc(c.portraitUrl)}" alt="">` : `<span>${esc(initials(c.name))}</span>`;
function appFlags(c) {
  const f = [], waiting = careerRows(c).filter(r => (r.status || 'pending') === 'pending');
  if (!c.portraitUrl) f.push('No picture'); if (!String(c.faceclaim || '').trim()) f.push('No face claim');
  if (waiting.some(isMajor)) f.push('Major achievement to check');
  return f;
}
function appRowHtml(c, sub) {
  const flags = appFlags(c), waiting = careerRows(c).filter(r => (r.status || 'pending') === 'pending').length, pref = prefLine(c);
  return `<button class="app-row" data-act="char-open" data-id="${esc(c.id)}" aria-label="Open ${esc(c.name)}’s application">
    <span class="app-thumb">${thumbOf(c)}</span>
    <span class="app-main"><b>${esc(c.name)}</b><span class="muted small">${esc(charRoleName(c.role))}${c.nationality ? ', ' + esc(c.nationality) : ''}. ${esc(sub)}</span>
      ${pref ? `<span class="small">${esc(pref.replace(/ “.*$/, ''))}</span>` : ''}</span>
    <span class="app-tags">${waiting ? `<span class="tag open">${plural(waiting, 'season')} to check</span>` : ''}${flags.map(x => `<span class="tag flag">${esc(x)}</span>`).join('')}</span>
    <span class="app-go" aria-hidden="true">Open ›</span></button>`;
}
chargenQueueHtml = function () {
  const pend = list('characters').filter(c => !c.retired && charStatus(c) === 'pending').sort((a, b) => String(a.submittedAt).localeCompare(String(b.submittedAt)));
  const changes = list('characters').filter(c => !c.retired && charStatus(c) === 'approved' && careerRows(c).some(r => (r.status || 'pending') === 'pending'));
  return `<section><h2 class="section-h">Character applications ${pend.length ? `<span class="count">${pend.length}</span>` : ''}</h2>
      ${pend.length ? `<div class="app-list">${pend.map(c => appRowHtml(c, `Sent ${fmtWhen(c.submittedAt)}`)).join('')}</div>` : '<p class="muted">No characters waiting.</p>'}</section>
    ${changes.length ? `<section><h2 class="section-h">Career record changes <span class="count">${changes.length}</span></h2><div class="app-list">${changes.map(c => appRowHtml(c, 'Approved; new or changed seasons')).join('')}</div></section>` : ''}`;
};

/* ---------------------------------------------------------------- the decision, on the application page */
function decisionHtml(c) {
  const g = c.gen || {}, driver = c.role === 'driver', waiting = careerRows(c).filter(r => (r.status || 'pending') === 'pending');
  const check = (ok, label) => `<li class="${ok ? 'ok' : 'miss'}"><span aria-hidden="true">${ok ? '✓' : '!'}</span>${label}</li>`;
  return `<section class="card decision"><h2>Race Control: decision</h2>
    <p class="small">Sent ${esc(fmtWhen(c.submittedAt))}${c.discord ? `. Discord: @${esc(c.discord)}` : ''}.</p>
    <ul class="checks">
      ${check(!!c.portraitUrl, c.portraitUrl ? 'Picture added' : 'No picture')}
      ${check(!!String(c.faceclaim || '').trim(), c.faceclaim ? `Face claim: ${esc(c.faceclaim)}` : 'No face claim')}
      ${check(!!String(c.personality || '').trim(), String(c.personality || '').trim() ? 'Personality written' : 'No personality written')}
      ${check(!!String(c.bio || '').trim(), String(c.bio || '').trim() ? 'Backstory written' : 'No backstory written')}
      ${PREF_ROLES.indexOf(c.role) !== -1 ? check(prefDone(c), prefLine(c) ? esc(prefLine(c)) : 'No team preference') : ''}
      ${driver ? check(!!g.rolls, g.rolls ? `${esc((bracketOf(g.bracket) || {}).name || '')}, roll ${g.rolls} of ${maxRolls(c)}${g.changes ? '; background changed once' : ''}${(g.history || []).length ? `; ${plural(g.history.length, 'earlier attempt')} below` : ''}` : 'Not rolled') : ''}
      ${check(true, `Flavour: ${flavourCount(c)} of ${FLAVOUR.length} optional sections`)}
      ${careerRows(c).some(r => seriesWarn(r)) ? check(false, `${plural(careerRows(c).filter(r => seriesWarn(r)).length, 'career season')} dated outside the series’ real years (see the career record)`) : ''}
      ${careerRows(c).length ? check(!waiting.some(isMajor), `${plural(careerRows(c).length, 'career season')}${waiting.length ? `, ${waiting.length} still to mark (approving makes them canon)` : ''}`) : ''}
    </ul>
    ${typeof approvalSeatHtml === 'function' ? approvalSeatHtml(c) : ''}
    <label class="field">Note to the player (needed to return it)<textarea id="dec-${esc(c.id)}" rows="2" data-bind="ui/form/rcnote/${esc(c.id)}">${esc(((S.ui.form.rcnote || {})[c.id]) || '')}</textarea></label>
    <label class="small"><input type="checkbox" data-bind="ui/form/postAccept/${esc(c.id)}" ${((S.ui.form.postAccept || {})[c.id]) !== false ? 'checked' : ''}> Post the acceptance card to Discord${c.discord ? `, mentioning @${esc(c.discord)}` : ' (no Discord username, so no @mention)'}</label>
    <div class="btn-row"><button class="btn primary" data-act="gen-approve" data-id="${esc(c.id)}">Approve</button><button class="btn" data-act="gen-return" data-id="${esc(c.id)}">Return with the note</button>
      ${driver ? `<button class="btn" data-act="gen-extra" data-id="${esc(c.id)}">Give an extra re-roll</button><button class="btn" data-act="gen-reset" data-id="${esc(c.id)}">Reset the ratings</button>` : ''}
      <button class="btn ghost" data-act="nav" data-route="control">Back to Race Control</button></div></section>`;
}
const _characterViewApprovals = ROUTES.character.view;
ROUTES.character.view = function () {
  const h = _characterViewApprovals(), c = get('characters', S.ui.charEdit);
  if (!c || !S.isGm || charStatus(c) !== 'pending') return h;
  const at = h.indexOf('</ol>');
  return at < 0 ? decisionHtml(c) + h : h.slice(0, at + 5) + decisionHtml(c) + h.slice(at + 5);
};
/* In the application's career record, Race Control marks seasons canon or not canon. */
careerAppHtml = function (c) {
  const rows = careerRows(c), can = careerEditable(c), f = S.ui.form.cr, rc = S.isGm && c.userId !== S.uid;
  return `<section class="card"><h2>Career record</h2>
    <p class="muted small">Seasons before F1 SIM, in any series: single-seaters, endurance, rally, touring and more. Each season waits for Race Control; only canon seasons show on the character page.</p>
    ${rows.length ? careerTableHtml(rows, { manage: can && !rc, review: S.isGm ? c.id : false }) : '<p class="muted">No seasons added yet.</p>'}
    ${can && !rc ? (f ? careerFormHtml(f) : '<div class="btn-row"><button class="btn" data-act="cr-add">Add a season</button></div>') : ''}</section>`;
};
/* After a decision, Race Control goes back to the list. */
const _genReturnBack = ACTIONS['gen-return'];
ACTIONS['gen-return'] = d => { const onPage = S.route === 'character'; _genReturnBack(d); if (onPage) waitFor(() => charStatus(get('characters', d.id) || {}) === 'returned', 8000).then(ok => { if (ok && S.route === 'character') go('control'); }); };
const _genApproveBack = ACTIONS['gen-approve'];
ACTIONS['gen-approve'] = d => { const onPage = S.route === 'character'; _genApproveBack(d); if (onPage) waitFor(() => charStatus(get('characters', d.id) || {}) === 'approved', 8000).then(ok => { if (ok && S.route === 'character') go('control'); }); };

/* =====================================================================
   F1 SIM — flavour and connections.
   Optional sections of the character sheet, filled in any time: goals
   and motivation, fears and insecurities, appearance, habits, hobbies,
   likes, dislikes, skills and family. They show on the character page,
   in the application and in the Google Doc.
   The Connections page: a character's connections (family, friends,
   rivals, work and romance), who counts them as a connection, and a map
   of every connection in the paddock.
   ===================================================================== */
'use strict';

const FLAVOUR = [
  ['goals', 'Goals and motivation', 'What drives them; what they want from the sport and from life'],
  ['fears', 'Fears and insecurities', 'What keeps them up at night; where they doubt themselves'],
  ['appearance', 'Appearance', 'Build, style, how they carry themselves, anything distinctive'],
  ['habits', 'Habits', 'Rituals, superstitions, tics, routines on a race weekend'],
  ['hobbies', 'Hobbies', 'What they do away from the track'],
  ['likes', 'Likes', 'Food, music, places, people, circuits'],
  ['dislikes', 'Dislikes', 'What winds them up'],
  ['skills', 'Skills', 'Talents in and out of the car'],
  ['family', 'Family', 'Parents, siblings, partners, children; who’s in their corner']
];
FLAVOUR.forEach(([k]) => { if (!(k in CHAR_BLANK)) CHAR_BLANK[k] = ''; });
const flavourCount = c => FLAVOUR.filter(([k]) => String((c || {})[k] || '').trim()).length;
function flavourFieldsHtml(f) {
  const n = flavourCount(f);
  return `<details class="flavour" ${n ? 'open' : ''}><summary><b>Add flavour (optional)</b> <span class="muted small">${n ? `${n} of ${FLAVOUR.length} filled. ` : ''}Fill in any of these now, or come back any time.</span></summary>
    <div class="flavour-grid">${FLAVOUR.map(([k, l, ph]) => `<label class="field">${esc(l)}<textarea id="ch-${k}" rows="3" maxlength="1500" data-bind="ui/form/ch/${k}" placeholder="${esc(ph)}">${esc(f[k] || '')}</textarea></label>`).join('')}</div></details>`;
}
function flavourCardHtml(c, title) {
  if (!c || !flavourCount(c)) return '';
  return `<section class="card flavour-card"><h2>${esc(title || 'More about them')}</h2><dl class="flavour-dl">${FLAVOUR.filter(([k]) => String(c[k] || '').trim()).map(([k, l]) => `<div><dt>${esc(l)}</dt><dd>${paras(c[k])}</dd></div>`).join('')}</dl></section>`;
}

/* ---------------------------------------------------------------- connections */
const REL_GROUPS = [
  ['family', 'Family', '#7CD69C', [['sibling', 'Sibling'], ['parent', 'Parent'], ['child', 'Child'], ['cousin', 'Cousin']]],
  ['friends', 'Friends', '#5AA9FF', [['friend', 'Friend'], ['bestfriend', 'Best friend']]],
  ['rivals', 'Rivals', '#E10600', [['rival', 'Rival'], ['nemesis', 'Nemesis'], ['history', 'Unfinished business']]],
  ['work', 'Work', '#F5C400', [['mentor', 'Mentor'], ['protege', 'Protégé'], ['teammate', 'Team-mate'], ['formerteammate', 'Former team-mate'], ['manager', 'Manager'], ['colleague', 'Colleague']]],
  ['romance', 'Romance', '#E58AD8', [['partner', 'Partner'], ['ex', 'Ex']]]
];
REL_GROUPS.forEach(g => g[3].forEach(k => { if (!REL_KINDS.some(x => x[0] === k[0])) REL_KINDS.push(k); }));
const relGroupOf = kind => REL_GROUPS.find(g => g[3].some(k => k[0] === kind)) || REL_GROUPS[2];
const relKindName = kind => (REL_KINDS.find(x => x[0] === kind) || [kind, kind])[1];
const personName = id => (F1.person(id) || {}).name || id;
function connPeople() {
  return list('f1_people').filter(p => p.approved !== false && (p.charId ? charApproved(get('characters', p.charId)) : true)).sort((a, b) => String(a.name).localeCompare(String(b.name)));
}
ACTIONS['conn-add'] = () => {
  const c = currentChar(), f = S.ui.form.conn || {}; if (!c) { toast('Choose a character to play as first.', true); return; }
  if (!f.otherId) { toast('Choose who the connection is with.', true); return; }
  if (f.otherId === f1PcId(c.id)) { toast('That’s them.', true); return; }
  run(async () => { await Data.put('f1_relations', newId('rel'), { userId: asOwner(), charId: c.id, personId: f1PcId(c.id), otherId: f.otherId, kind: f.kind || 'friend', note: String(f.note || '').trim().slice(0, 600), at: nowIso() }); S.ui.form.conn = { kind: f.kind || 'friend' }; }, 'Connection added.');
};
ACTIONS['conn-remove'] = d => askConfirm('Remove this connection?', 'Remove', () => run(async () => { await Data.remove('f1_relations', d.id); }, 'Removed.'), true);
ACTIONS['conn-filter'] = d => { S.ui.connFilter = d.g; render(); };
function connMapHtml(rels, filter) {
  const shown = rels.filter(r => !filter || relGroupOf(r.kind)[0] === filter);
  const ids = [...new Set(shown.flatMap(r => [r.personId, r.otherId]))];
  if (!ids.length) return '<p class="muted">No connections to show yet.</p>';
  const W = 760, H = 560, cx = W / 2, cy = H / 2, R = Math.min(W, H) / 2 - 70;
  const pos = {}; ids.forEach((id, i) => { const a = -Math.PI / 2 + i * 2 * Math.PI / ids.length; pos[id] = [cx + R * Math.cos(a), cy + R * Math.sin(a), a]; });
  const node = id => { const p = F1.person(id) || {}, c = p.charId ? get('characters', p.charId) : null, seat = c ? primarySeat(c.id) : null, col = seat ? f1Colour(seat.teamId) : p.teamId ? f1Colour(p.teamId) : '#8A8F98';
    const [x, y, a] = pos[id], right = Math.cos(a) >= 0, label = p.name || id;
    return `<a href="#career" data-act="career" data-id="${esc(id)}" aria-label="${esc(label)}"><circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${p.charId ? 11 : 8}" fill="${esc(col)}" stroke="#FFFFFF" stroke-width="${p.charId ? 2 : 0}"></circle>
      <text x="${(x + (right ? 16 : -16)).toFixed(1)}" y="${(y + 4).toFixed(1)}" text-anchor="${right ? 'start' : 'end'}" class="conn-label">${esc(label)}</text></a>`; };
  /* Two people can have several connections: those lines bow apart so each one shows. */
  const pairKey = r => [r.personId, r.otherId].sort().join('|'), pairs = {};
  shown.forEach(r => { (pairs[pairKey(r)] = pairs[pairKey(r)] || []).push(r.id); });
  const edge = r => { const a = pos[r.personId], b = pos[r.otherId]; if (!a || !b) return ''; const col = relGroupOf(r.kind)[2];
    const grp = pairs[pairKey(r)], j = grp.indexOf(r.id), off = (j - (grp.length - 1) / 2) * 36;
    const [p, q] = [r.personId, r.otherId].sort() [0] === r.personId ? [a, b] : [b, a];
    const mx = (p[0] + q[0]) / 2, my = (p[1] + q[1]) / 2, dx = q[0] - p[0], dy = q[1] - p[1], len = Math.hypot(dx, dy) || 1;
    const cxp = mx - dy / len * off, cyp = my + dx / len * off;
    return `<path class="conn-edge" d="M${a[0].toFixed(1)},${a[1].toFixed(1)} Q${cxp.toFixed(1)},${cyp.toFixed(1)} ${b[0].toFixed(1)},${b[1].toFixed(1)}" fill="none" stroke="${col}" stroke-width="2.5" stroke-opacity="0.9"><title>${esc(personName(r.personId))}: ${esc(relKindName(r.kind))} of ${esc(personName(r.otherId))}</title></path>`; };
  return `<div class="scroll-x"><svg class="conn-map" viewBox="0 0 ${W} ${H}" role="img" aria-label="Map of ${plural(shown.length, 'connection')} between ${plural(ids.length, 'person', 'people')}">${shown.map(edge).join('')}${ids.map(node).join('')}</svg></div>`;
}
route('connections', 'Connections', function () {
  const c = currentChar(), me = c ? f1PcId(c.id) : null, rels = list('f1_relations').filter(r => F1.person(r.personId) && F1.person(r.otherId));
  const mine = me ? rels.filter(r => r.personId === me) : [], theirs = me ? rels.filter(r => r.otherId === me) : [], filter = S.ui.connFilter || '';
  const f = S.ui.form.conn = S.ui.form.conn || { kind: 'friend' };
  const row = (r, other, del) => { const g = relGroupOf(r.kind);
    return `<li class="conn-row"><span class="conn-dot" style="background:${g[2]}"></span><div><b>${esc(relKindName(r.kind))}:</b> ${careerLink(other, personName(other))}${r.note ? `<p class="muted small">${esc(r.note)}</p>` : ''}</div>${del ? `<button class="btn small ghost" data-act="conn-remove" data-id="${esc(r.id)}">Remove</button>` : ''}</li>`; };
  let h = `<div class="page-head"><div><h1>Connections</h1><p>Family, friends, rivals, colleagues and old flames: who’s connected to whom in the paddock.</p></div></div>`;
  if (c) h += `<div class="cols2" style="align-items:start"><section class="card"><h2>${esc(c.name)}’s connections</h2>${mine.length ? `<ul class="conn-list">${mine.map(r => row(r, r.otherId, true)).join('')}</ul>` : '<p class="muted">None yet.</p>'}
      <h3>Add a connection</h3><div class="form-grid">
        <label class="field">Who${sel('conn-other', 'ui/form/conn/otherId', f.otherId || '', connPeople().filter(p => p.id !== me).map(p => [p.id, p.name + (p.charId ? '' : ' (real driver)')]), 'Choose someone')}</label>
        <label class="field">What they are to ${esc(c.name.split(' ')[0])}<select id="conn-kind" data-bind="ui/form/conn/kind">${REL_GROUPS.map(([gid, gl, , ks]) => `<optgroup label="${esc(gl)}">${ks.map(([k, l]) => `<option value="${k}" ${f.kind === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}</optgroup>`).join('')}</select></label></div>
      <label class="field">The story (optional)<textarea id="conn-note" rows="3" maxlength="600" data-bind="ui/form/conn/note" placeholder="e.g. Karting rivals since they were nine. Neither has forgiven Macau.">${esc(f.note || '')}</textarea></label>
      <div class="btn-row"><button class="btn primary" data-act="conn-add">Add the connection</button></div></section>
    <section class="card"><h2>Who counts ${esc(c.name.split(' ')[0])} as a connection</h2>${theirs.length ? `<ul class="conn-list">${theirs.map(r => `<li class="conn-row"><span class="conn-dot" style="background:${relGroupOf(r.kind)[2]}"></span><div>${careerLink(r.personId, personName(r.personId))} counts ${esc(c.name.split(' ')[0])} as a <b>${esc(relKindName(r.kind).toLowerCase())}</b>${r.note ? `<p class="muted small">${esc(r.note)}</p>` : ''}</div></li>`).join('')}</ul>` : '<p class="muted">Nobody yet.</p>'}</section></div>`;
  else h += `<div class="card notice"><p>Choose a character to play as to add their connections. Everyone’s connections are on the map below.</p></div>`;
  h += `<section class="card"><h2>Across the paddock</h2>
    <div class="chips" role="group" aria-label="Show">${[['', 'All']].concat(REL_GROUPS.map(g => [g[0], g[1]])).map(([g, l]) => `<button class="chip ${filter === g ? 'on' : ''}" data-act="conn-filter" data-g="${g}" aria-pressed="${filter === g}">${g ? `<span class="conn-dot" style="background:${relGroupOf((REL_GROUPS.find(x => x[0] === g) || [])[3][0][0])[2]}"></span>` : ''}${esc(l)}</button>`).join('')}</div>
    ${connMapHtml(rels, filter)}
    <details><summary>All connections as a list (${rels.filter(r => !filter || relGroupOf(r.kind)[0] === filter).length})</summary><ul class="conn-list">${rels.filter(r => !filter || relGroupOf(r.kind)[0] === filter).map(r => `<li class="conn-row"><span class="conn-dot" style="background:${relGroupOf(r.kind)[2]}"></span><div>${careerLink(r.personId, personName(r.personId))}: <b>${esc(relKindName(r.kind).toLowerCase())}</b> of ${careerLink(r.otherId, personName(r.otherId))}${r.note ? `<p class="muted small">${esc(r.note)}</p>` : ''}</div></li>`).join('')}</ul></details></section>`;
  return h;
});
(() => { const i = NAV.findIndex(x => x[0] === 'people'); if (i !== -1 && !NAV.some(x => x[0] === 'connections')) NAV.splice(i + 1, 0, ['connections', 'users', 'Connections']); })();

/* =====================================================================
   F1 SIM — Teams, and all-time and career standings.
   Teams: every team of a series in a season (this one or an earlier,
   catalogued one), and each team's page: the season (stats, line-up,
   points by round, race by race) and its previous championships
   (honours, season by season, everyone who has driven for it), with a
   team card to download or post to Discord. Open to everyone.
   Championship: as well as this season, all-time in F1 SIM (every season
   of the series added up) and career (F1 SIM plus each driver's canon
   seasons in other championships).
   ===================================================================== */
'use strict';

/* ---------------------------------------------------------------- seasons and standings */
function seriesSeasons(sid) {
  const out = list('f1_seasons').filter(s => (s.seriesId || 'f1') === sid);
  const cur = seasonDoc(curSeasonId(sid)); if (!out.some(s => s.id === cur.id)) out.push(cur);
  return out.sort((a, b) => String(b.startedAt || b.name).localeCompare(String(a.startedAt || a.name)));
}
const teamSeasonWeekends = (sid, sea) => list('f1_weekends').filter(w => w.status === 'finished' && wSeries(w) === sid && wSeason(w) === sea && w.session !== 'test');
function standingsFor(sid, sea) {
  const drivers = new Map(), teams = new Map();
  teamSeasonWeekends(sid, sea).sort((a, b) => String(a.finishedAt).localeCompare(String(b.finishedAt))).forEach(w => (w.results || []).forEach(r => {
    const d = drivers.get(r.personId) || { personId: r.personId, name: r.name, teamId: r.teamId, charId: r.charId, pts: 0, wins: 0, podiums: 0, starts: 0, best: 99 };
    d.pts += r.points || 0; d.teamId = r.teamId; d.name = r.name;
    if (w.session !== 'sprint') { d.starts += 1; if (r.position === 1) d.wins += 1; if (r.position && r.position <= 3) d.podiums += 1; if (r.position) d.best = Math.min(d.best, r.position); }
    drivers.set(r.personId, d);
    const t = teams.get(r.teamId) || { teamId: r.teamId, pts: 0, wins: 0, podiums: 0 }; t.pts += r.points || 0;
    if (w.session !== 'sprint' && r.position === 1) t.wins += 1; if (w.session !== 'sprint' && r.position && r.position <= 3) t.podiums += 1; teams.set(r.teamId, t);
  }));
  const order = (a, b) => b.pts - a.pts || b.wins - a.wins || (a.best || 99) - (b.best || 99);
  return { drivers: [...drivers.values()].sort(order), teams: [...teams.values()].sort(order) };
}
const seasonDone = sea => seasonDoc(sea).status === 'archived';
const teamEngine = (teamId, sid, sea) => { const cfg = engineConfig(sid, sea), f = ENGINE_FORMULAS[cfg.formula]; return `${supplierOf(teamId, cfg)} ${f ? f.short : ''}`.trim(); };
const ordinalPos = n => n ? `P${n}` : '–';
const roundsOf = sid => (seriesDoc(sid).calendar || []).length || list('f1_tracks').length;

/* ---------------------------------------------------------------- the Teams index */
ACTIONS['teams-series'] = d => { S.ui.teamsSeries = d.id; S.ui.teamsSeason = null; render(); };
CHANGES['teams-season'] = v => { S.ui.teamsSeason = v; render(); };
ACTIONS['team-open'] = d => { S.ui.teamView = d.id; S.ui.teamTab = d.tab || 'season'; go('teamview'); };
ACTIONS['team-tab'] = d => { S.ui.teamTab = d.tab; render(); };
function teamsCtx() {
  const sid = S.ui.teamsSeries || curSeriesId(), seasons = seriesSeasons(sid), sea = S.ui.teamsSeason && seasons.some(s => s.id === S.ui.teamsSeason) ? S.ui.teamsSeason : curSeasonId(sid);
  return { sid, sea, seasons, current: sea === curSeasonId(sid) };
}
function teamDrivers(t, sid, sea, st) {
  if (sea === curSeasonId(sid)) return list('f1_seats').filter(s => s.teamId === t.id && s.role === 'driver').sort((a, b) => (a.car || 0) - (b.car || 0)).map(s => {
    const c = s.holderCharId ? get('characters', s.holderCharId) : null, p = c ? F1.person(f1PcId(c.id)) : F1.person(s.defaultPersonId) || {}, pid = c ? f1PcId(c.id) : s.defaultPersonId;
    const i = st.drivers.findIndex(d => d.personId === pid); return { pid, name: c ? c.name : p.name || 'Open seat', num: c ? c.number : p.num, player: !!c, canon: !c && !!p.name && !!s.open, c, pos: i + 1, pts: i >= 0 ? st.drivers[i].pts : 0 }; });
  return st.drivers.map((d, i) => Object.assign({}, d, { pos: i + 1 })).filter(d => d.teamId === t.id).slice(0, 3).map(d => ({ pid: d.personId, name: d.name, num: (F1.person(d.personId) || {}).num, player: !!d.charId, c: d.charId ? get('characters', d.charId) : null, pos: d.pos, pts: d.pts }));
}
function teamStaffLine(t) {
  const seats = list('f1_seats').filter(s => s.teamId === t.id), tp = seats.find(s => s.role === 'principal'), eng = seats.filter(s => s.role === 'engineer');
  const tpName = tp ? (tp.holderCharId ? (get('characters', tp.holderCharId) || {}).name : (F1.person(tp.defaultPersonId) || {}).name || 'computer-run') : '';
  const engNames = eng.filter(s => s.holderCharId).map(s => (get('characters', s.holderCharId) || {}).name);
  return [tpName ? `Principal: ${tpName}` : '', engNames.length ? `Engineer${engNames.length > 1 ? 's' : ''}: ${engNames.join(', ')}` : ''].filter(Boolean).join(' · ');
}
route('teams', 'Teams', function () {
  const { sid, sea, seasons, current } = teamsCtx(), st = standingsFor(sid, sea), s = seriesDoc(sid), done = teamSeasonWeekends(sid, sea).filter(w => w.session === 'gp').length;
  const teams = list('f1_teams').filter(t => (t.seriesId || 'f1') === sid).sort((a, b) => { const pa = st.teams.findIndex(x => x.teamId === a.id), pb = st.teams.findIndex(x => x.teamId === b.id); return (pa < 0 ? 99 : pa) - (pb < 0 ? 99 : pb) || (a.order || 0) - (b.order || 0); });
  const champ = sea => { const t = standingsFor(sid, sea).teams[0]; return t ? (get('f1_teams', t.teamId) || {}).name : ''; };
  const series = allSeries().filter(x => list('f1_teams').some(t => (t.seriesId || 'f1') === x.id));
  const card = t => { const i = st.teams.findIndex(x => x.teamId === t.id), row = st.teams[i] || { pts: 0 }, col = f1Colour(t.id), ink = inkOn(col), ds = teamDrivers(t, sid, sea, st);
    return `<button class="tm-card" data-act="team-open" data-id="${esc(t.id)}" aria-label="Open ${esc(t.name)}">
      <span class="tm-band" style="background:${esc(col)};color:${ink}"><span><b>${esc(t.name)}</b><br><small>${esc(teamEngine(t.id, sid, sea))}</small></span><span class="tm-pos"><b>${i >= 0 ? `P${i + 1}` : '–'}</b><br><small>${row.pts} pts</small></span></span>
      <span class="tm-drivers">${ds.map(d => `<span class="tm-driver"><span class="tm-face" style="${d.player ? `background:${esc(col)};color:${ink}` : ''}">${personPic(d.pid, d.c) ? `<img src="${esc(personPic(d.pid, d.c))}" alt="">` : esc(initials(d.name))}</span>
        <span><b>${esc(d.name)}</b>${d.player ? ' <span class="tag player">Player</span>' : ''}${d.canon ? ' <span class="muted small">(open for players)</span>' : ''}<br><small class="muted">${d.pos ? `P${d.pos}, ${d.pts} pts` : 'No points yet'}</small></span><span class="tm-num">${esc(d.num || '')}</span></span>`).join('') || '<span class="muted small">No results this season.</span>'}</span>
      ${typeof teamStaffHtml === 'function' ? teamStaffHtml(t, sid, sea) : ''}
      <span class="tm-foot"><span></span><b>Open team ›</b></span></button>`; };
  return `<div class="page-head"><div><p class="eyebrow">${esc(s.name)} · ${esc(seasonDoc(sea).name)} season · ${current ? `after round ${done} of ${roundsOf(sid)}` : 'final standings'}</p><h1>Teams</h1></div>
      <div class="btn-row">${false ? `<div class="seg" role="tablist" aria-label="Series">${series.map(x => `<button role="tab" aria-selected="${x.id === sid}" data-act="teams-series" data-id="${esc(x.id)}">${esc(x.name)}</button>`).join('')}</div>` : ''}
      <label class="sr-only" for="teams-season">Season</label><select id="teams-season" data-change="teams-season">${seasons.map(x => `<option value="${esc(x.id)}" ${x.id === sea ? 'selected' : ''}>${esc(x.name)}${x.id === curSeasonId(sid) ? ' (this season)' : champ(x.id) && seasonDone(x.id) ? `: champions ${esc(champ(x.id))}` : ''}</option>`).join('')}</select></div></div>
    <div class="tm-grid">${teams.map(card).join('')}</div>`;
});
const inkOn = hexc => { const h = String(hexc || '#888').replace('#', ''), n = parseInt(h.length === 3 ? h.split('').map(x => x + x).join('') : h, 16); const r = n >> 16 & 255, g = n >> 8 & 255, b = n & 255; return (0.299 * r + 0.587 * g + 0.114 * b) > 150 ? '#141519' : '#FFFFFF'; };

/* ---------------------------------------------------------------- a team's page */
function teamSeasonData(tid, sid, sea) {
  const st = standingsFor(sid, sea), i = st.teams.findIndex(x => x.teamId === tid), row = st.teams[i] || { pts: 0, wins: 0, podiums: 0 };
  const ws = teamSeasonWeekends(sid, sea).sort((a, b) => String(a.finishedAt).localeCompare(String(b.finishedAt)));
  const gps = ws.filter(w => w.session === 'gp'); let poles = 0, fls = 0;
  gps.forEach(w => { const mine = (w.results || []).filter(r => r.teamId === tid).map(r => r.id); if (w.quali && w.quali.grid && mine.indexOf(w.quali.grid[0]) !== -1) poles++; if (w.state && w.state.fastest && mine.indexOf(w.state.fastest.id) !== -1) fls++; });
  const rounds = gps.map(w => { const t = get('f1_tracks', w.trackId) || {}, rs = (w.results || []).filter(r => r.teamId === tid);
    const sprintPts = ws.filter(x => x.session === 'sprint' && x.trackId === w.trackId).reduce((s, x) => s + (x.results || []).filter(r => r.teamId === tid).reduce((a, r) => a + (r.points || 0), 0), 0);
    return { round: t.round, name: t.name || w.trackId, code: (t.name || w.trackId).slice(0, 3).toUpperCase(), cars: rs.map(r => ({ name: r.name, pos: r.position })), pts: rs.reduce((a, r) => a + (r.points || 0), 0) + sprintPts }; });
  return { pos: i + 1, pts: row.pts, wins: row.wins, podiums: row.podiums, poles, fls, rounds, st };
}
function teamHistoryData(tid, sid) {
  const seasons = seriesSeasons(sid).slice().reverse(), rows = [], people = new Map(); let titles = 0, dTitles = [], wins = 0, podiums = 0, starts = 0;
  seasons.forEach(sea => {
    const st = standingsFor(sid, sea.id), i = st.teams.findIndex(x => x.teamId === tid); if (i < 0) return;
    const done = seasonDone(sea.id), t = st.teams[i], drivers = st.drivers.map((d, k) => Object.assign({}, d, { pos: k + 1 })).filter(d => d.teamId === tid);
    if (done && i === 0) titles++; if (done && st.drivers[0] && st.drivers[0].teamId === tid) dTitles.push(`${st.drivers[0].name}, ${sea.name}`);
    wins += t.wins; podiums += t.podiums;
    rows.push({ season: sea.name, done, pos: i + 1, pts: t.pts, wins: t.wins, podiums: t.podiums, engines: (ENGINE_FORMULAS[engineConfig(sid, sea.id).formula] || {}).short || '', drivers: drivers.map(d => `${d.name} (${done && d.pos === 1 ? 'Champion' : 'P' + d.pos})`).join(', ') });
    teamSeasonWeekends(sid, sea.id).filter(w => w.session === 'gp').forEach(w => (w.results || []).filter(r => r.teamId === tid).forEach(r => {
      starts++; const p = people.get(r.personId) || { pid: r.personId, name: r.name, charId: r.charId, starts: 0, wins: 0, seasons: new Set(), champ: [] };
      p.starts++; if (r.position === 1) p.wins++; p.seasons.add(sea.name); people.set(r.personId, p); }));
    if (done && st.drivers[0] && st.drivers[0].teamId === tid && people.get(st.drivers[0].personId)) people.get(st.drivers[0].personId).champ.push(sea.name);
  });
  return { rows: rows.reverse(), titles, dTitles, wins, podiums, starts, people: [...people.values()].sort((a, b) => b.wins - a.wins || b.starts - a.starts) };
}
function teamLineup(t) {
  const seats = list('f1_seats').filter(s => s.teamId === t.id).sort((a, b) => ({ driver: 0, principal: 1, engineer: 2 }[a.role] - { driver: 0, principal: 1, engineer: 2 }[b.role]) || (a.car || 0) - (b.car || 0));
  return seats.map(s => { const c = s.holderCharId ? get('characters', s.holderCharId) : null, p = !c && s.defaultPersonId ? F1.person(s.defaultPersonId) : null;
    const role = s.role === 'driver' ? `Driver, car ${s.car || 1}` : s.role === 'principal' ? 'Team principal' : `Race engineer${s.car ? `, car ${s.car}` : ''}`;
    return { role, c, pid: c ? f1PcId(c.id) : p ? p.id : null, name: c ? c.name : p ? p.name : 'Open post', player: !!c, open: !c && !p, real: !c && !!p, canon: !c && !!p && !!s.open, num: c ? c.number : p ? p.num : '' }; });
}
route('teamview', 'Team', function () {
  const t = get('f1_teams', S.ui.teamView); if (!t) return '<div class="empty">Choose a team from Teams.</div>';
  const sid = t.seriesId || 'f1', { sea } = (S.ui.teamsSeries === sid ? teamsCtx() : { sea: curSeasonId(sid) }), tab = S.ui.teamTab || 'season', col = f1Colour(t.id), ink = inkOn(col), br = teamBrand(t.id) || {};
  const hist = teamHistoryData(t.id, sid);
  let h = `<button class="btn ghost small" data-act="nav" data-route="teams">‹ All teams</button>
    <section class="tm-banner" style="background:${esc(col)};color:${ink}"><div><p>${esc(seriesDoc(sid).name)} · ${esc(teamEngine(t.id, sid, sea))}</p><h1>${br.logo ? `<img class="team-logo" src="${esc(br.logo)}" alt="">` : ''}${esc(t.name)}</h1>
      <p>${hist.titles ? `Constructors’ champions ${hist.rows.filter(r => r.done && r.pos === 1).map(r => esc(r.season)).join(', ')}. ` : ''}${esc(seasonDoc(sea).name)} season.</p></div>
      ${br.car ? `<img class="tm-car" src="${esc(br.car)}" alt="${esc(t.name)}’s car">` : ''}</section>
    <div class="tm-tabs"><div class="seg" role="tablist" aria-label="Team page"><button role="tab" aria-selected="${tab === 'season'}" data-act="team-tab" data-tab="season">${esc(seasonDoc(sea).name)} season</button><button role="tab" aria-selected="${tab === 'history'}" data-act="team-tab" data-tab="history">Previous championships</button></div>
      <button class="btn" data-act="tcard-open" data-id="${esc(t.id)}">Export the team card</button></div>`;
  if (tab === 'season') {
    const d = teamSeasonData(t.id, sid, sea), maxP = Math.max(1, ...d.rounds.map(r => r.pts));
    h += `<div class="metrics tm-stats">${[[d.pos ? `P${d.pos}` : '–', 'Constructors’ championship'], [d.pts, 'Points'], [d.wins, 'Wins'], [d.podiums, 'Podiums'], [d.poles, 'Poles'], [d.fls, 'Fastest laps']].map(([v, k]) => `<div class="metric"><b>${esc(v)}</b><span>${esc(k)}</span></div>`).join('')}</div>`;
    if (sea === curSeasonId(sid)) h += `<section class="card"><h2>Line-up</h2><div class="tm-lineup">${teamLineup(t).map(m => `<${m.pid ? `button data-act="career" data-id="${esc(m.pid)}"` : 'div'} class="tm-member ${m.player ? 'player' : m.open ? 'open' : ''}">
        <span class="tm-face" style="${m.player ? `background:${esc(col)};color:${ink}` : ''}">${personPic(m.pid, m.c) ? `<img src="${esc(personPic(m.pid, m.c))}" alt="">` : m.open ? '+' : esc(initials(m.name))}</span>
        <span><small class="muted">${esc(m.role)}</small><br><b>${esc(m.name)}</b>${m.player ? ' <span class="tag player">Player</span>' : ''}${m.canon ? ' <span class="muted small">(open for players)</span>' : ''}<br><small class="muted">${m.open ? 'Apply on the site' : m.num ? '#' + esc(m.num) : m.player ? '' : 'Computer-run'}</small></span></${m.pid ? 'button' : 'div'}>`).join('')}</div></section>`;
    h += d.rounds.length ? `<section class="card"><h2>Points by round</h2><p class="muted small">Both cars together, sprints included.</p>
        <svg class="tm-bars" viewBox="0 0 ${Math.max(360, d.rounds.length * 56 + 40)} 200" width="${Math.max(360, d.rounds.length * 56 + 40)}" height="200" role="img" aria-label="${esc(t.name)} points by round: ${d.rounds.map(r => r.pts).join(', ')}">
        <line x1="20" y1="168" x2="${d.rounds.length * 56 + 30}" y2="168" stroke="var(--line)"></line>${d.rounds.map((r, i) => { const hh = r.pts / maxP * 130; return `<rect x="${30 + i * 56}" y="${168 - hh}" width="40" height="${hh}" fill="${esc(col)}"></rect><text x="${50 + i * 56}" y="${160 - hh}" text-anchor="middle" class="tm-bar-v">${r.pts}</text><text x="${50 + i * 56}" y="188" text-anchor="middle" class="tm-bar-l">${esc(r.code)}</text>`; }).join('')}</svg></section>
      <section class="card"><h2>Race by race</h2><div class="scroll-x"><table class="data"><thead><tr><th>Round</th><th>Grand Prix</th><th>Cars</th><th class="num">Points</th></tr></thead><tbody>${d.rounds.map(r => `<tr><td class="muted">R${esc(r.round)}</td><td><b>${esc(r.name)}</b></td><td>${r.cars.map(c => `<span class="tm-pill ${c.pos === 1 ? 'p1' : c.pos && c.pos <= 3 ? 'pod' : !c.pos ? 'out' : ''}">${c.pos ? 'P' + c.pos : 'Out'}</span> ${esc(c.name)}`).join(' &nbsp; ')}</td><td class="num"><b>${r.pts}</b></td></tr>`).join('')}</tbody></table></div></section>`
      : '<p class="muted">No races yet this season.</p>';
  } else {
    h += `<section class="card"><h2>Honours</h2><div class="metrics tm-honours"><div class="metric ${hist.titles ? 'gold' : ''}"><b>${hist.titles}</b><span>Constructors’ titles</span></div><div class="metric ${hist.dTitles.length ? 'gold' : ''}"><b>${hist.dTitles.length}</b><span>Drivers’ titles${hist.dTitles.length ? `: ${esc(hist.dTitles.join('; '))}` : ''}</span></div><div class="metric"><b>${hist.wins}</b><span>Grand Prix wins</span></div><div class="metric"><b>${hist.podiums}</b><span>Podiums in ${hist.starts ? Math.round(hist.starts / 2) : 0} Grands Prix</span></div></div></section>
      <section class="card"><h2>Season by season</h2>${hist.rows.length ? `<div class="scroll-x"><table class="data"><thead><tr><th>Season</th><th>Engines</th><th>Constructors’</th><th class="num">Points</th><th class="num">Wins</th><th class="num">Podiums</th><th>Drivers (championship)</th></tr></thead><tbody>${hist.rows.map(r => `<tr><td><b>${esc(r.season)}</b>${r.done ? '' : ' <span class="muted small">so far</span>'}</td><td class="muted">${esc(r.engines)}</td><td>${r.done && r.pos === 1 ? '<span class="tag trophy">Champions</span>' : `P${r.pos}`}</td><td class="num"><b>${r.pts}</b></td><td class="num">${r.wins}</td><td class="num">${r.podiums}</td><td>${esc(r.drivers)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">No seasons yet.</p>'}</section>
      <section class="card"><h2>Everyone who has driven for ${esc(t.name)}</h2>${hist.people.length ? `<div class="tm-lineup">${hist.people.map(p => { const c = p.charId ? get('characters', p.charId) : null;
        return `<button class="tm-member" data-act="career" data-id="${esc(p.pid)}"><span class="tm-face" style="${c ? `background:${esc(col)};color:${ink}` : ''}">${personPic(p.pid, c) ? `<img src="${esc(personPic(p.pid, c))}" alt="">` : esc(initials(p.name))}</span><span><b>${esc(p.name)}</b>${p.champ.length ? ` <span class="tag trophy">Champion ${esc(p.champ.join(', '))}</span>` : ''}<br><small class="muted">${esc([...p.seasons].join(', '))} · ${plural(p.starts, 'start')} · ${plural(p.wins, 'win')}${c ? ' · player' : ''}</small></span></button>`; }).join('')}</div>` : '<p class="muted">Nobody yet.</p>'}</section>`;
  }
  return h;
});
['teams', 'teamview'].forEach(r => { if (LIMITED_ROUTES.indexOf(r) === -1) LIMITED_ROUTES.push(r); });
(() => { const i = NAV.findIndex(x => x[0] === 'grid'); if (i !== -1 && !NAV.some(x => x[0] === 'teams')) NAV.splice(i + 1, 0, ['teams', 'flag', 'Teams']); })();

/* ---------------------------------------------------------------- the team card */
async function drawTeamCard(tid) {
  const t = get('f1_teams', tid); if (!t) return null;
  const sid = t.seriesId || 'f1', sea = curSeasonId(sid), d = teamSeasonData(tid, sid, sea), hist = teamHistoryData(tid, sid), col = f1Colour(tid), ink = inkOn(col);
  const W = 1080, H = 1350, cv = document.createElement('canvas'); cv.width = W; cv.height = H; const g = cv.getContext('2d'), T = EXP_THEMES.dark;
  try { await Promise.all(['700 100px "Titillium Web"', '900 100px "Titillium Web"', '600 30px "Titillium Web"'].map(f => document.fonts.load(f))); } catch (e) { /* fall back */ }
  g.fillStyle = '#1C1D22'; g.fillRect(0, 0, W, H); g.fillStyle = col; g.fillRect(0, 0, W, 300);
  g.fillStyle = ink === '#FFFFFF' ? 'rgba(255,255,255,0.14)' : 'rgba(20,21,25,0.14)'; g.font = cond(900, 340); g.textAlign = 'right'; g.fillText(d.pos ? `P${d.pos}` : '', W + 10, 270); g.textAlign = 'left';
  g.fillStyle = ink; g.font = cond(700, 26); g.fillText(`F1 SIM · ${seriesDoc(sid).name} · ${seasonDoc(sea).name} season`, 56, 80);
  fitText(g, t.name, z => cond(900, z), 118, W - 112); g.fillText(t.name, 52, 200);
  g.font = cond(700, 26); g.fillText(`${teamEngine(tid, sid, sea)} · ${d.pos ? `P${d.pos} after round ${d.rounds.length} of ${roundsOf(sid)}` : 'Season to start'}`, 56, 250);
  [[d.pos ? `P${d.pos}` : '–', 'Constructors’'], [String(d.pts), 'Points'], [String(d.wins), 'Wins'], [String(d.podiums), 'Podiums']].forEach(([v, k], i) => { const x = 56 + i * 246; g.fillStyle = T.panel; g.fillRect(x, 340, 230, 120); g.fillStyle = '#FFFFFF'; g.font = cond(900, 56); g.fillText(v, x + 18, 405); g.font = bodyF(500, 20); g.fillStyle = T.muted; g.fillText(k, x + 18, 440); });
  const lu = teamLineup(t), drivers = lu.filter(m => /^Driver/.test(m.role)).slice(0, 2), imgs = await Promise.all(drivers.map(m => loadImg(personPic(m.pid, m.c) || null)));
  drivers.forEach((m, i) => { const x = 56 + i * 492, y = 500, w = 476, hh = 200, row = d.st.drivers.findIndex(x2 => x2.personId === m.pid);
    g.fillStyle = m.player ? '#3A1D20' : T.panel; g.fillRect(x, y, w, hh); if (m.player) { g.strokeStyle = '#E10600'; g.lineWidth = 3; g.strokeRect(x + 1.5, y + 1.5, w - 3, hh - 3); }
    if (m.num) { g.fillStyle = 'rgba(255,255,255,0.07)'; g.font = cond(900, 170); g.textAlign = 'right'; g.fillText(String(m.num), x + w - 10, y + hh - 6); g.textAlign = 'left'; }
    drawPhoto(g, imgs[i], x + 18, y + 22, 120, 156, 4, { name: m.name }, T);
    g.fillStyle = m.player ? '#FF8A80' : T.muted; g.font = bodyF(600, 19); g.fillText(m.player ? `Player · car ${i + 1}` : m.canon ? `Car ${i + 1} · open for players` : `Car ${i + 1}`, x + 158, y + 60);
    g.fillStyle = '#FFFFFF'; fitText(g, m.name, z => cond(900, z), 36, w - 176); g.fillText(m.name, x + 158, y + 104);
    g.fillStyle = '#C9CCD2'; g.font = bodyF(500, 20); g.fillText(row >= 0 ? `P${row + 1} · ${d.st.drivers[row].pts} pts` : 'No points yet', x + 158, y + 140); });
  const tp = lu.find(m => m.role === 'Team principal'), engs = lu.filter(m => /^Race engineer/.test(m.role));
  [[`Team principal`, tp ? `${tp.name}${tp.player ? ' (player)' : tp.canon ? ' (open for players)' : ''}` : '–'], ['Race engineers', engs.map((m, k) => `Car ${k + 1}: ${m.open ? 'open' : m.name + (m.player ? ' (player)' : '')}`).join(' · ') || 'Open posts']].forEach(([k, v], i) => { const x = 56 + i * 492; g.fillStyle = T.panel; g.fillRect(x, 730, 476, 96); g.fillStyle = T.muted; g.font = bodyF(500, 18); g.fillText(k, x + 18, 766); g.fillStyle = '#FFFFFF'; fitText(g, v, z => cond(700, z), 26, 440); g.fillText(v, x + 18, 804); });
  if (hist.titles || hist.dTitles.length) { g.fillStyle = '#F5C400'; g.fillRect(56, 856, W - 112, 84); g.fillStyle = '#2A2200'; g.font = cond(900, 30); g.fillText('Honours', 76, 908);
    const txt = [hist.titles ? `Constructors’ champions ${hist.rows.filter(r => r.done && r.pos === 1).map(r => r.season).join(', ')}` : '', hist.dTitles.length ? `Drivers’ champion: ${hist.dTitles.join('; ')}` : ''].filter(Boolean).join(' · ');
    fitText(g, txt, z => bodyF(600, z), 22, W - 112 - 200); g.fillText(txt, 230, 906); }
  const rs = d.rounds.slice(-8), maxP = Math.max(1, ...rs.map(r => r.pts));
  if (rs.length) { g.fillStyle = T.muted; g.font = bodyF(600, 20); g.fillText('Points by round', 56, 990); rs.forEach((r, i) => { const x = 56 + i * 120, hh = r.pts / maxP * 118; g.fillStyle = col; g.fillRect(x, 1170 - hh, 84, hh); g.fillStyle = '#FFFFFF'; g.font = cond(700, 22); g.textAlign = 'center'; g.fillText(String(r.pts), x + 42, 1162 - hh); g.fillStyle = T.muted; g.font = bodyF(600, 18); g.fillText(r.code, x + 42, 1198); g.textAlign = 'left'; }); }
  g.fillStyle = T.muted; g.font = bodyF(500, 18); g.fillText(`Updated ${stampText()}`, 56, H - 50); g.textAlign = 'right'; g.fillText('F1 SIM', W - 56, H - 50); g.textAlign = 'left';
  g.fillStyle = col; g.fillRect(0, H - 16, W, 16);
  return new Promise(ok => cv.toBlob(ok, 'image/png'));
}
ACTIONS['tcard-open'] = d => { S.ui.tcard = { tid: d.id, url: null, blob: null }; openDrawer('tcard'); (async () => { const x = S.ui.tcard, blob = await drawTeamCard(d.id); if (S.ui.tcard !== x || !blob) return; x.blob = blob; x.url = URL.createObjectURL(blob); renderOverlay(); })(); if (S.isGm) discordChannels().then(() => renderOverlay()).catch(() => {}); };
DRAWERS.tcard = function () { const x = S.ui.tcard || {}, t = get('f1_teams', x.tid) || {};
  return `<header><div><h2>${esc(t.name || '')} team card</h2><p>Download it, or post it to Discord.</p></div><button class="btn ghost" data-act="close-drawer">Close</button></header>
    <div class="body">${x.url ? `<img class="card-preview tx-preview" src="${x.url}" alt="${esc(t.name || '')} team card">` : '<p class="muted">Drawing the card…</p>'}
    <div class="btn-row"><button class="btn primary" data-act="tcard-png" ${x.url ? '' : 'disabled'}>Download</button>${S.isGm ? `<button class="btn" data-act="tcard-discord" ${x.url ? '' : 'disabled'}>Post to Discord</button>` : ''}${x.posted ? `<span class="tag player">Posted to #${esc(x.posted)}</span>` : ''}</div></div>`; };
ACTIONS['tcard-png'] = () => { const x = S.ui.tcard; if (!x || !x.url) return; const t = get('f1_teams', x.tid) || {}, a = document.createElement('a'); a.href = x.url; a.download = `${fileSafe(t.name)}-team-card.png`; document.body.appendChild(a); a.click(); a.remove(); };
ACTIONS['tcard-discord'] = () => { const x = S.ui.tcard; if (!x || !x.blob) return; const t = get('f1_teams', x.tid) || {};
  run(async () => { x.posted = await discordSend('standings', { content: `**${t.name}**: ${seriesDoc(t.seriesId || 'f1').name}, ${seasonDoc(curSeasonId(t.seriesId || 'f1')).name} season` }, { blob: x.blob, name: `${fileSafe(t.name)}-team-card.png` }); }, 'Posted to Discord.'); };

/* ---------------------------------------------------------------- all-time and career standings */
ACTIONS['stand-view'] = d => { S.ui.standView = d.v; render(); };
function allTimeData(sid) {
  const seasons = seriesSeasons(sid), drivers = new Map(), teams = new Map();
  seasons.forEach(sea => { const st = standingsFor(sid, sea.id), done = seasonDone(sea.id);
    st.drivers.forEach((d, i) => { const o = drivers.get(d.personId) || { personId: d.personId, name: d.name, charId: d.charId, teamId: d.teamId, seasons: 0, starts: 0, wins: 0, podiums: 0, pts: 0, titles: [] };
      o.seasons++; o.starts += d.starts; o.wins += d.wins; o.podiums += d.podiums; o.pts += d.pts; o.teamId = d.teamId; o.name = d.name; if (done && i === 0) o.titles.push(sea.name); drivers.set(d.personId, o); });
    st.teams.forEach((t, i) => { const o = teams.get(t.teamId) || { teamId: t.teamId, seasons: 0, wins: 0, podiums: 0, pts: 0, titles: [] }; o.seasons++; o.wins += t.wins; o.podiums += t.podiums; o.pts += t.pts; if (done && i === 0) o.titles.push(sea.name); teams.set(t.teamId, o); });
    teamSeasonWeekends(sid, sea.id).filter(w => w.session === 'gp' && w.quali && w.quali.grid).forEach(w => { const pole = (w.results || []).find(r => r.id === w.quali.grid[0]); if (pole && drivers.get(pole.personId)) drivers.get(pole.personId).poles = (drivers.get(pole.personId).poles || 0) + 1; });
  });
  const order = (a, b) => b.titles.length - a.titles.length || b.wins - a.wins || b.podiums - a.podiums || b.pts - a.pts;
  return { drivers: [...drivers.values()].sort(order), teams: [...teams.values()].sort(order), seasons };
}
function careerData() {
  const people = new Map();
  list('f1_weekends').filter(w => w.status === 'finished' && w.session !== 'test').forEach(w => (w.results || []).forEach(r => { if (!people.has(r.personId)) people.set(r.personId, { pid: r.personId, name: r.name, charId: r.charId }); }));
  list('characters').filter(c => !c.retired && charApproved(c) && (c.role === 'driver' || careerRows(c).some(r => r.status === 'canon'))).forEach(c => { const pid = f1PcId(c.id); if (!people.has(pid)) people.set(pid, { pid, name: c.name, charId: c.id }); });
  return [...people.values()].map(x => { const p = F1.person(x.pid) || { id: x.pid, name: x.name }, c = x.charId ? get('characters', x.charId) : null, rows = winsByChampionship(p, c);
    const titles = []; careerRows(c).filter(r => r.status === 'canon' && String(r.pos) === '1' && (r.role || 'driver') === 'driver').forEach(r => titles.push(`${seriesLabel(r)} ${r.years}`));
    seriesIdsAll().forEach(sid => seriesSeasons(sid).filter(s => seasonDone(s.id)).forEach(s => { const st = standingsFor(sid, s.id); if (st.drivers[0] && st.drivers[0].personId === x.pid) titles.push(`F1 SIM ${seriesDoc(sid).short || seriesDoc(sid).name} ${s.name}`); }));
    return { pid: x.pid, name: p.name || x.name, c, titles, wins: rows.reduce((s, r) => s + r.wins, 0), podiums: rows.reduce((s, r) => s + r.podiums, 0), champs: rows.length, list: rows.map(r => r.name) }; })
    .filter(x => x.wins || x.podiums || x.titles.length || x.c).sort((a, b) => b.titles.length - a.titles.length || b.wins - a.wins || b.podiums - a.podiums || a.name.localeCompare(b.name));
}
const seriesIdsAll = () => [...new Set(list('f1_teams').map(t => t.seriesId || 'f1'))];
const _standingsViewTeams = ROUTES.standings.view;
ROUTES.standings.view = function () {
  const v = S.ui.standView || 'season', sid = curSeriesId(), s = seriesDoc(sid);
  const tabs = `<div class="seg stand-tabs" role="tablist" aria-label="Standings">${[['season', `${seasonDoc(curSeasonId(sid)).name} season`], ['alltime', 'All-time in F1 SIM'], ['career', 'Career: every championship']].map(([k, l]) => `<button role="tab" aria-selected="${v === k}" data-act="stand-view" data-v="${k}">${esc(l)}</button>`).join('')}</div>`;
  if (v === 'season') { const h = _standingsViewTeams(), i = h.indexOf('</div></div>'); return i < 0 ? tabs + h : h.slice(0, i + 12) + tabs + h.slice(i + 12); }
  const head = `<div class="page-head"><div><h1>Championship</h1><p>${v === 'alltime' ? `${esc(s.name)}: every F1 SIM season added up, from the first to this one. Titles count once a season is catalogued.` : 'Every driver’s whole career: their F1 SIM races in every series, and their canon seasons in other championships before it (Formula 2, F1 Academy, WEC and the rest). Only seasons Race Control has accepted count.'}</p></div></div>${tabs}`;
  if (v === 'alltime') {
    const a = allTimeData(sid);
    return head + `<div class="cols2" style="align-items:start"><section class="card"><h2>Drivers</h2><div class="scroll-x"><table class="data"><thead><tr><th>Pos</th><th>Driver</th><th class="num">Seasons</th><th class="num">Starts</th><th class="num">Wins</th><th class="num">Podiums</th><th class="num">Poles</th><th class="num">Points</th><th>Titles</th></tr></thead><tbody>${a.drivers.map((d, i) => `<tr${S.charId && d.charId === S.charId ? ' class="me"' : ''}><td><b>${i + 1}</b></td><td>${careerLink(d.personId, d.name)}${d.charId ? ' <span class="tag player">Player</span>' : ''}</td><td class="num">${d.seasons}</td><td class="num">${d.starts}</td><td class="num">${d.wins}</td><td class="num">${d.podiums}</td><td class="num">${d.poles || 0}</td><td class="num"><b>${d.pts}</b></td><td>${d.titles.map(x => `<span class="tag trophy">${esc(x)}</span>`).join(' ')}</td></tr>`).join('')}</tbody></table></div></section>
      <section class="card"><h2>Constructors</h2><div class="scroll-x"><table class="data"><thead><tr><th>Pos</th><th>Team</th><th class="num">Seasons</th><th class="num">Wins</th><th class="num">Podiums</th><th class="num">Points</th><th>Titles</th></tr></thead><tbody>${a.teams.map((t, i) => `<tr><td><b>${i + 1}</b></td><td><button class="link-btn" data-act="team-open" data-id="${esc(t.teamId)}" data-tab="history"><span class="f1-bar" style="background:${esc(f1Colour(t.teamId))}"></span>${esc((get('f1_teams', t.teamId) || {}).name || t.teamId)}</button></td><td class="num">${t.seasons}</td><td class="num">${t.wins}</td><td class="num">${t.podiums}</td><td class="num"><b>${t.pts}</b></td><td>${t.titles.map(x => `<span class="tag trophy">${esc(x)}</span>`).join(' ')}</td></tr>`).join('')}</tbody></table></div></section></div>
      <p class="muted small">${plural(a.seasons.length, 'season')}: ${a.seasons.slice().reverse().map(x => esc(x.name) + (seasonDone(x.id) ? '' : ' (this season)')).join(', ')}.</p>`;
  }
  const cd = careerData();
  return head + `<section class="card"><h2>Career standings</h2><div class="scroll-x"><table class="data"><thead><tr><th>Pos</th><th>Driver</th><th class="num">Titles</th><th class="num">Wins</th><th class="num">Podiums</th><th class="num">Championships</th><th>Titles won</th></tr></thead><tbody>${cd.map((d, i) => `<tr${S.charId && d.c && d.c.id === S.charId ? ' class="me"' : ''}><td><b>${i + 1}</b></td><td>${careerLink(d.pid, d.name)}${d.c ? ' <span class="tag player">Player</span>' : ''}<div class="muted small">${esc(d.list.join(', '))}</div></td><td class="num"><b>${d.titles.length}</b></td><td class="num">${d.wins}</td><td class="num">${d.podiums}</td><td class="num">${d.champs}</td><td>${d.titles.map(x => `<span class="tag trophy">${esc(x)}</span>`).join(' ')}</td></tr>`).join('')}</tbody></table></div>
    <p class="muted small">F1 SIM races count automatically. Seasons in other championships come from each driver’s canon career record.</p></section>`;
};

/* =====================================================================
   F1 SIM — JSON download and upload, for characters and seasons.
   Characters: download one, yours, or (Race Control) everyone's; upload
   to create drafts (players; ratings in the file are ignored and career
   seasons await approval) or, for Race Control, approved characters with
   the file's ratings. A character's own id in the file updates it.
   Seasons: download any season with every result; Race Control uploads
   past seasons (results matched to drivers and teams by name, points
   filled in from the points table, new names added as drivers), which
   become catalogued seasons. A file for the current season only sets its
   engine era and round dates. Every upload is checked and previewed first.
   ===================================================================== */
'use strict';

const IO_CH = 'f1sim-characters', IO_SEASON = 'f1sim-season';
const slugOf = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'x';
function downloadJson(name, obj) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' }), url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
}
function readJsonFile(el) {
  return new Promise((ok, bad) => { const f = el.files && el.files[0]; if (!f) return bad(new Error('No file chosen.'));
    if (f.size > 5e6) return bad(new Error('That file is over 5 MB.'));
    const r = new FileReader(); r.onload = () => { try { ok(JSON.parse(String(r.result))); } catch (e) { bad(new Error('That isn’t valid JSON: ' + e.message)); } }; r.onerror = () => bad(new Error('The file couldn’t be read.')); r.readAsText(f); });
}

/* ---------------------------------------------------------------- characters out */
const CH_TEXT = ['name', 'role', 'nationality', 'code', 'discord', 'faceclaim', 'portraitUrl', 'nickname', 'birthplace', 'personality', 'bio', 'junior', 'helmet'];
const RATING_KEYS = ['pace', 'consistency', 'wet', 'overtaking', 'defense', 'experience', 'mental', 'years', 'style'];
function charToJson(c) {
  const o = { id: c.id, status: charStatus(c) };
  CH_TEXT.concat(FLAVOUR.map(f => f[0])).forEach(k => { if (c[k] != null && c[k] !== '') o[k] = c[k]; });
  if (c.number) o.number = c.number;
  if (careerRows(c).length) o.career = careerRows(c).map(r => ({ years: r.years, series: r.series, other: r.other || undefined, team: r.team || undefined, wins: r.wins === '' ? undefined : r.wins, podiums: r.podiums === '' ? undefined : r.podiums, poles: r.poles === '' ? undefined : r.poles, pos: r.pos || undefined, notes: r.notes || undefined, status: r.status || 'pending' }));
  if (c.teamPref && (c.teamPref.first || c.teamPref.any)) o.teamPref = { first: c.teamPref.first || undefined, second: c.teamPref.second || undefined, why: c.teamPref.why || undefined, any: !!c.teamPref.any };
  if (c.role === 'driver') { const p = F1.person(f1PcId(c.id)), r = p && p.approved ? f1DevApply(Object.assign({}, F1_ROOKIE, p), c.id) : rolledRatings(c);
    if (r) { o.ratings = {}; RATING_KEYS.forEach(k => { if (r[k] != null) o.ratings[k] = r[k]; }); } }
  return o;
}
const chBundle = cs => ({ format: IO_CH, version: 1, exportedAt: nowIso(), characters: cs.map(charToJson) });
ACTIONS['io-ch-one'] = d => { const c = get('characters', d.id); if (c) downloadJson(`${fileSafe(c.name)}.json`, chBundle([c])); };
ACTIONS['io-ch-mine'] = () => { const cs = myChars().filter(c => !c.retired); if (!cs.length) { toast('No characters to download yet.', true); return; } downloadJson('my-characters.json', chBundle(cs)); };
ACTIONS['io-ch-all'] = () => { if (!S.isGm) return; downloadJson(`all-characters-${new Date().toISOString().slice(0, 10)}.json`, chBundle(list('characters').filter(c => !c.retired))); };
ACTIONS['io-ch-template'] = () => downloadJson('character-template.json', { format: IO_CH, version: 1, characters: [{
  name: 'Amelia Hart', role: 'driver', nationality: 'Scottish', code: 'HAR', number: 28, discord: 'amelia.hart', faceclaim: 'Who the picture shows', nickname: 'The Dundee Dart', birthplace: 'Dundee',
  personality: 'How they come across: temperament, quirks, how they handle pressure.', bio: 'Backstory: where they come from and how they got into the paddock.', junior: 'Karting and junior series.', helmet: 'Saltire blue with a gold stripe',
  goals: 'Optional', fears: 'Optional', appearance: 'Optional', habits: 'Optional', hobbies: 'Optional', likes: 'Optional', dislikes: 'Optional', skills: 'Optional', family: 'Optional',
  career: [{ years: '2025', series: 'Formula 2', team: 'ART', wins: 5, podiums: 11, poles: 4, pos: '1', notes: 'Optional' }, { years: '2024', series: 'Other', other: 'Super GT', team: 'Team Le Mans', wins: 1, podiums: 2, pos: '9' }],
  teamPref: { first: 'mclaren', second: 'williams', why: 'Optional', any: false },
  ratings: { pace: 82, consistency: 80, wet: 78, overtaking: 81, defense: 79, experience: 50, mental: 7, years: 4, style: 'technical' } }],
  notes: { role: CHAR_ROLES.map(r => r[0]).join(', '), series: CAREER_GROUPS.flatMap(g => g[1]).join(', '), pos: '1 = champion, 2 to 10, 11 = lower, 0 = part season', style: F1_STYLES.map(s => s[0]).join(', '),
    ratings: 'Used only when Race Control imports characters as approved. Players roll their ratings on the site.', teams: 'teamPref takes team ids or names.' } });

/* ---------------------------------------------------------------- characters in */
const capStr = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
const teamIdOf = v => { const s = String(v || '').trim().toLowerCase(); if (!s) return ''; const t = list('f1_teams').find(x => x.id === s || String(x.name || '').toLowerCase() === s); return t ? t.id : null; };
function normaliseChar(x, i, problems) {
  const where = `Character ${i + 1}${x && x.name ? ` (${x.name})` : ''}`;
  if (!x || typeof x !== 'object') { problems.push(`${where}: not an object.`); return null; }
  const name = capStr(x.name, 60); if (!name) { problems.push(`${where}: needs a name.`); return null; }
  const roles = CHAR_ROLES.map(r => r[0]), role = roles.indexOf(x.role) !== -1 ? x.role : 'driver';
  if (x.role && roles.indexOf(x.role) === -1) problems.push(`${where}: role “${x.role}” isn’t one of ${roles.join(', ')}; using driver.`);
  const o = { id: typeof x.id === 'string' ? x.id : null, name, role };
  ['nationality', 'discord', 'faceclaim', 'nickname', 'birthplace', 'helmet'].forEach(k => { if (x[k]) o[k] = capStr(x[k], 120); });
  ['personality', 'bio', 'junior'].concat(FLAVOUR.map(f => f[0])).forEach(k => { if (x[k]) o[k] = capStr(x[k], 4000); });
  if (x.code) o.code = String(x.code).toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3);
  if (x.number != null && x.number !== '') { const n = Math.round(Number(x.number)); if (n >= 1 && n <= 99) o.number = n; else problems.push(`${where}: car number must be 1 to 99.`); }
  if (x.portraitUrl && /^https?:\/\//.test(String(x.portraitUrl))) o.portraitUrl = String(x.portraitUrl).slice(0, 500);
  if (x.discord) o.discord = String(x.discord).trim().replace(/^@+/, '').replace(/\s+/g, '').slice(0, 40);
  const series = CAREER_GROUPS.flatMap(g => g[1]), num = v => v === '' || v == null || isNaN(Number(v)) ? '' : Math.max(0, Math.round(Number(v)));
  o.career = (Array.isArray(x.career) ? x.career : []).slice(0, 40).map((r, j) => { if (!r || !r.years) { problems.push(`${where}, career season ${j + 1}: needs years.`); return null; }
    const known = series.indexOf(r.series) !== -1, row = { role: CAREER_ROLE_KEYS.indexOf(r.role) !== -1 ? r.role : 'driver', years: capStr(r.years, 20), series: known ? r.series : 'Other', other: known ? capStr(r.other, 60) : capStr(r.other || r.series, 60), team: capStr(r.team, 60), wins: num(r.wins), podiums: num(r.podiums), poles: num(r.poles), pos: String(r.pos == null ? '' : r.pos), notes: capStr(r.notes, 200), status: ['canon', 'notcanon', 'pending'].indexOf(r.status) !== -1 ? r.status : 'pending' };
    if (row.wins !== '' && row.podiums !== '' && row.wins > row.podiums) problems.push(`${where}, ${row.years} ${row.series}: more wins than podiums.`);
    if (seriesWarn(row)) problems.push(`${where}, ${row.years} ${row.series}: ${seriesWarn(row)}`);
    return row; }).filter(Boolean);
  if (x.teamPref && typeof x.teamPref === 'object') { const f = teamIdOf(x.teamPref.first), s = teamIdOf(x.teamPref.second);
    if (f === null) problems.push(`${where}: team “${x.teamPref.first}” isn’t on the grid.`); if (s === null) problems.push(`${where}: team “${x.teamPref.second}” isn’t on the grid.`);
    o.teamPref = { first: f || '', second: s || '', why: capStr(x.teamPref.why, 200), any: !!x.teamPref.any }; }
  if (x.ratings && typeof x.ratings === 'object' && role === 'driver') { const r = {};
    ['pace', 'consistency', 'wet', 'overtaking', 'defense', 'experience'].forEach(k => { if (x.ratings[k] != null) r[k] = Math.max(1, Math.min(99, Math.round(Number(x.ratings[k]) || 0))); });
    if (x.ratings.mental != null) r.mental = Math.max(1, Math.min(10, Math.round(Number(x.ratings.mental) || 5)));
    if (x.ratings.years != null) r.years = Math.max(0, Math.min(40, Math.round(Number(x.ratings.years) || 0)));
    if (x.ratings.style && F1_STYLES.some(s => s[0] === x.ratings.style)) r.style = x.ratings.style;
    o.ratings = r; }
  const existing = o.id ? get('characters', o.id) : null;
  o.update = !!(existing && (existing.userId === S.uid || S.isGm)); if (!o.update) o.id = null;
  return o;
}
CHANGES['io-ch-file'] = (v, d, el) => {
  readJsonFile(el).then(j => {
    const arr = j && j.format === IO_CH && Array.isArray(j.characters) ? j.characters : Array.isArray(j) ? j : j && j.name ? [j] : null;
    if (!arr) throw new Error('This isn’t an F1 SIM characters file. Download the template to see the layout.');
    const problems = [], items = arr.slice(0, 100).map((x, i) => normaliseChar(x, i, problems)).filter(Boolean);
    S.ui.io = { kind: 'ch', items, problems, mode: 'draft' }; openDrawer('io');
  }).catch(e => toast(e.message || String(e), true));
  el.value = '';
};
CHANGES['io-mode'] = v => { if (S.ui.io) { S.ui.io.mode = v; renderOverlay(); } };
ACTIONS['io-ch-run'] = () => {
  const x = S.ui.io; if (!x || x.kind !== 'ch' || !x.items.length) return; const approve = S.isGm && x.mode === 'approved';
  run(async () => {
    let made = 0, updated = 0;
    for (const it of x.items) {
      const { update, ratings, career, ...fields } = it, id = update ? it.id : await newCharId(), prev = update ? get('characters', id) : null;
      const rows = career.map(r => Object.assign({ id: newId('cr'), at: nowIso() }, r, { status: S.isGm ? (approve && r.status === 'pending' ? 'canon' : r.status) : 'pending' }));
      const doc = Object.assign({}, prev ? clone(S.store.characters[id]) : { createdAt: nowIso(), userId: S.uid, status: 'draft' }, fields, { career: rows, updatedAt: nowIso() });
      delete doc.update; delete doc.ratings; doc.id = undefined; delete doc.id;
      if (approve && !(prev && charStatus(prev) === 'approved')) {
        const pid = f1PcId(id), base = fields.role === 'driver' ? Object.assign({}, F1_ROOKIE, ratings || {}) : {};
        await Data.put('f1_people', pid, Object.assign(base, { kind: ['principal', 'engineer', 'driver'].indexOf(fields.role) !== -1 ? fields.role : fields.role, charId: id, name: fields.name, abbr: fields.code || f1Code(fields.name), num: fields.number || null, flag: '', approved: true, imported: true, approvedAt: nowIso() }));
        Object.assign(doc, { status: 'approved', decidedAt: nowIso(), gen: Object.assign({}, doc.gen || {}, { imported: true, style: (ratings || {}).style || 'technical' }) });
      }
      await Data.put('characters', id, doc); if (update) updated++; else made++;
    }
    await Data.audit('io.characters', `Imported characters: ${made} new, ${updated} updated${approve ? ', as approved' : ''}`);
    closeDrawer();
    toast(`${plural(made, 'character')} created${updated ? `, ${updated} updated` : ''}${approve ? ', approved' : ' as drafts'}.`);
  });
};

/* ---------------------------------------------------------------- seasons out */
function seasonToJson(sid, sea) {
  const sd = seasonDoc(sea), cfg = engineConfig(sid, sea), s = seriesDoc(sid);
  const ws = list('f1_weekends').filter(w => w.status === 'finished' && wSeries(w) === sid && wSeason(w) === sea && w.session !== 'test').sort((a, b) => String(a.finishedAt).localeCompare(String(b.finishedAt)));
  return { format: IO_SEASON, version: 1, exportedAt: nowIso(), series: sid, seriesName: s.name, season: { name: sd.name, status: sd.status === 'archived' ? 'archived' : 'current', engine: cfg.formula },
    rounds: ws.map(w => { const t = get('f1_tracks', w.trackId) || {}, grid = (w.quali && w.quali.grid) || [];
      return { track: w.trackId, trackName: t.name || '', session: w.session, date: String(w.finishedAt || w.createdAt || '').slice(0, 10) || ((s.dates || {})[w.trackId] || ''),
        results: (w.results || []).slice().sort((a, b) => (a.position || 99) - (b.position || 99)).map(r => ({ position: r.position || null, driver: r.name, code: r.id, team: r.teamId, teamName: (get('f1_teams', r.teamId) || {}).name || '', points: r.points || 0, grid: r.grid || (grid.indexOf(r.id) + 1) || null, stops: r.stops, status: r.position ? 'finished' : (r.gap || 'out') })) }; }),
    dates: sd.status === 'archived' ? undefined : (s.dates || {}) };
}
CHANGES['io-season-pick'] = v => { S.ui.ioSeason = v; };
ACTIONS['io-season-down'] = () => { const sid = curSeriesId(), sea = S.ui.ioSeason || curSeasonId(sid); downloadJson(`${sid}-${fileSafe(seasonDoc(sea).name)}-season.json`, seasonToJson(sid, sea)); };
ACTIONS['io-season-template'] = () => downloadJson('season-template.json', { format: IO_SEASON, version: 1, series: curSeriesId(), season: { name: '2025', status: 'archived', engine: 'hybrid14' },
  rounds: [{ track: 'australia', session: 'gp', date: '2025-03-16', results: [{ position: 1, driver: 'Lando Norris', team: 'mclaren', grid: 1 }, { position: 2, driver: 'Max Verstappen', team: 'redbull', grid: 3 }, { position: null, driver: 'Charles Leclerc', team: 'ferrari', status: 'Accident' }] },
    { track: 'china', session: 'sprint', date: '2025-03-22', results: [{ position: 1, driver: 'Lewis Hamilton', team: 'ferrari' }] }],
  notes: { status: 'archived = a past season (results become history); current = only sets this season’s engine era and dates', engine: ENGINE_ORDER.join(', '), track: list('f1_tracks').map(t => t.id).join(', '), session: 'gp or sprint',
    team: 'team id or name in this series', points: 'optional: filled in from the points table by position', driver: 'matched by name; new names are added as drivers on the record' } });

/* ---------------------------------------------------------------- seasons in (Race Control) */
function checkSeason(j) {
  const problems = [], warn = [];
  if (!j || j.format !== IO_SEASON) return { problems: ['This isn’t an F1 SIM season file. Download the template to see the layout.'] };
  const sid = j.series || curSeriesId(); if (!allSeries().some(s => s.id === sid)) problems.push(`Series “${sid}” doesn’t exist.`);
  const name = capStr((j.season || {}).name, 40); if (!name) problems.push('The season needs a name.');
  const status = (j.season || {}).status === 'current' ? 'current' : 'archived', engine = ENGINE_FORMULAS[(j.season || {}).engine] ? j.season.engine : null;
  if ((j.season || {}).engine && !engine) problems.push(`Engine era “${j.season.engine}” isn’t one of ${ENGINE_ORDER.join(', ')}.`);
  if (status === 'archived' && seriesSeasons(sid).some(s => s.name === name && !s.imported)) problems.push(`${name} is already a season of this series; give the imported season another name.`);
  const tracks = list('f1_tracks'), trackOf = v => { const s = String(v || '').toLowerCase(); return tracks.find(t => t.id === s || String(t.name || '').toLowerCase() === s || String(t.circuit || '').toLowerCase() === s); };
  const teams = list('f1_teams').filter(t => (t.seriesId || 'f1') === sid), teamOf = v => { const s = String(v || '').toLowerCase(); return teams.find(t => t.id === s || String(t.name || '').toLowerCase() === s); };
  const people = list('f1_people'), newDrivers = new Set();
  const rounds = (Array.isArray(j.rounds) ? j.rounds : []).slice(0, 60).map((r, i) => {
    const t = trackOf(r.track || r.trackName), where = `Round ${i + 1}`; if (!t) { problems.push(`${where}: track “${r.track || r.trackName}” isn’t known.`); return null; }
    const session = r.session === 'sprint' ? 'sprint' : 'gp', res = (Array.isArray(r.results) ? r.results : []).map((x, k) => {
      const team = teamOf(x.team || x.teamName); if (!team) { problems.push(`${where} (${t.name}): team “${x.team || x.teamName}” isn’t in this series.`); return null; }
      const dn = capStr(x.driver, 60); if (!dn) { problems.push(`${where} (${t.name}), result ${k + 1}: needs a driver.`); return null; }
      const p = people.find(pp => String(pp.name || '').toLowerCase() === dn.toLowerCase()); if (!p) newDrivers.add(dn);
      const pos = x.position == null || x.position === '' ? null : Math.round(Number(x.position)); return { pos, driver: dn, person: p || null, team: team.id, points: x.points, grid: x.grid, stops: x.stops, status: x.status, code: x.code };
    }).filter(Boolean);
    if (!res.length && status === 'archived') warn.push(`${where} (${t.name}) has no results.`);
    return { track: t.id, name: t.name, session, date: /^\d{4}-\d{2}-\d{2}$/.test(String(r.date || '')) ? r.date : '', res };
  }).filter(Boolean);
  if (status === 'archived' && !rounds.length) problems.push('There are no rounds to import.');
  return { problems, warn, sid, name, status, engine, rounds, newDrivers: [...newDrivers], dates: j.dates && typeof j.dates === 'object' ? j.dates : null };
}
CHANGES['io-season-file'] = (v, d, el) => {
  if (!S.isGm) return;
  readJsonFile(el).then(j => { S.ui.io = Object.assign({ kind: 'season' }, checkSeason(j)); openDrawer('io'); }).catch(e => toast(e.message || String(e), true));
  el.value = '';
};
ACTIONS['io-season-run'] = () => {
  const x = S.ui.io; if (!S.isGm || !x || x.kind !== 'season' || x.problems.length) return;
  run(async () => {
    if (x.status === 'current') {
      const s = seriesDoc(x.sid), sea = curSeasonId(x.sid), dates = Object.assign({}, s.dates || {});
      x.rounds.forEach(r => { if (r.date) dates[r.track] = r.date; }); if (x.dates) Object.keys(x.dates).forEach(k => { if (/^\d{4}-\d{2}-\d{2}$/.test(x.dates[k])) dates[k] = x.dates[k]; });
      await Data.put('f1_series', x.sid, Object.assign(get('f1_series', x.sid) ? clone(S.store.f1_series[x.sid]) : { template: x.sid, activeSeason: sea }, { dates }));
      if (x.engine) { const cur = get('f1_seasons', sea) ? clone(S.store.f1_seasons[sea]) : Object.assign({}, seasonDoc(sea)); delete cur.implicit; cur.engine = Object.assign({}, engineConfig(x.sid, sea), cur.engine || {}, { formula: x.engine }); await Data.put('f1_seasons', sea, cur); }
      await Data.audit('io.season', `${seriesDoc(x.sid).name}: this season's dates${x.engine ? ' and engines' : ''} imported`); closeDrawer(); toast('This season’s dates and engines are updated.'); return;
    }
    const sea = `${x.sid}-imp-${slugOf(x.name)}`, rules = seriesRules(seriesDoc(x.sid)), sprintPts = rules.sprintPoints || [8, 7, 6, 5, 4, 3, 2, 1];
    for (const w of list('f1_weekends').filter(w => wSeason(w) === sea && w.imported)) await Data.remove('f1_weekends', w.id);
    const made = {};
    for (const dn of x.newDrivers) { const id = `imp-${slugOf(dn)}`; if (!F1.person(id)) await Data.put('f1_people', id, Object.assign({}, F1_ROOKIE, { kind: 'driver', name: dn, abbr: f1Code(dn), approved: true, imported: true })); made[dn.toLowerCase()] = id; }
    const ws = [];
    x.rounds.forEach((r, i) => {
      const day = r.date || `${x.name.replace(/\D/g, '').slice(0, 4) || '2000'}-01-${String(Math.min(28, i + 1)).padStart(2, '0')}`;
      const results = r.res.slice().sort((a, b) => (a.pos || 99) - (b.pos || 99)).map(e => { const pid = e.person ? e.person.id : made[e.driver.toLowerCase()], p = e.person || {};
        const pts = e.points != null && e.points !== '' ? Number(e.points) || 0 : e.pos ? ((r.session === 'sprint' ? sprintPts : rules.points)[e.pos - 1] || 0) : 0;
        return { id: e.code || p.abbr || f1Code(e.driver), personId: pid, name: e.driver, teamId: e.team, charId: p.charId || null, position: e.pos, points: pts, grid: e.grid || null, stops: e.stops || 0, gap: e.pos ? null : (e.status || 'Out') }; });
      const grid = results.filter(e => e.grid).sort((a, b) => a.grid - b.grid).map(e => e.id);
      ws.push({ id: newId('f1w'), seriesId: x.sid, seasonId: sea, trackId: r.track, session: r.session, status: 'finished', imported: true, createdAt: `${day}T12:00:00.000Z`, finishedAt: `${day}T15:00:00.000Z`, results, quali: grid.length ? { grid } : null });
    });
    for (const w of ws) await Data.put('f1_weekends', w.id, w);
    const st = standingsOf(ws), snap = { drivers: st.drivers.map(d => ({ personId: d.personId, name: d.name, teamId: d.teamId, teamName: (get('f1_teams', d.teamId) || {}).name || '', charId: d.charId || null, pts: d.pts, wins: d.wins, podiums: d.podiums })),
      teams: st.teams.map(t => ({ teamId: t.teamId, name: t.name || (get('f1_teams', t.teamId) || {}).name, pts: t.pts, wins: t.wins })), races: ws.filter(w => w.session === 'gp').length, sprints: ws.filter(w => w.session === 'sprint').length };
    await Data.put('f1_seasons', sea, { seriesId: x.sid, name: x.name, status: 'archived', imported: true, startedAt: ws[0] ? ws[0].createdAt : nowIso(), endedAt: ws.length ? ws[ws.length - 1].finishedAt : nowIso(), engine: { formula: x.engine || 'hybrid26', teams: {}, ratings: {} }, archive: snap });
    await Data.audit('io.season', `${seriesDoc(x.sid).name} ${x.name} imported: ${plural(ws.length, 'round')}, ${x.newDrivers.length} new drivers`);
    closeDrawer(); toast(`${x.name} imported: ${plural(ws.length, 'round')}${x.newDrivers.length ? `, ${plural(x.newDrivers.length, 'new driver')} on the record` : ''}.`);
  });
};

/* ---------------------------------------------------------------- the preview */
DRAWERS.io = function () {
  const x = S.ui.io || {}, bad = (x.problems || []).length;
  const probs = bad ? `<div class="card notice warn"><b>${plural(bad, 'thing')} to fix in the file:</b><ul>${x.problems.slice(0, 30).map(p => `<li>${esc(p)}</li>`).join('')}</ul></div>` : '';
  if (x.kind === 'ch') {
    const blocking = x.items.length === 0;
    return `<header><div><h2>Import characters</h2><p>${plural(x.items.length, 'character')} in the file. Check them, then import.</p></div><button class="btn ghost" data-act="close-drawer">Close</button></header>
      <div class="body">${probs}<div class="scroll-x"><table class="data compact"><thead><tr><th>Name</th><th>Role</th><th class="num">Career seasons</th><th>Flavour</th><th></th></tr></thead><tbody>${x.items.map(it => `<tr><td><b>${esc(it.name)}</b>${it.code ? ` <span class="muted small">${esc(it.code)}${it.number ? ' #' + it.number : ''}</span>` : ''}</td><td>${esc(charRoleName(it.role))}</td><td class="num">${it.career.length}</td><td>${flavourCount(it)} of ${FLAVOUR.length}</td><td>${it.update ? '<span class="tag open">Updates yours</span>' : '<span class="tag">New</span>'}</td></tr>`).join('')}</tbody></table></div>
      ${S.isGm ? `<label class="field" style="max-width:420px">Import as<select data-change="io-mode"><option value="draft" ${x.mode === 'draft' ? 'selected' : ''}>Drafts (they roll and send their applications)</option><option value="approved" ${x.mode === 'approved' ? 'selected' : ''}>Approved, with the ratings in the file</option></select></label>` : '<p class="muted small">They arrive as drafts: roll the ratings and send each application as usual. Career seasons wait for Race Control.</p>'}
      <div class="btn-row"><button class="btn primary" data-act="io-ch-run" ${blocking ? 'disabled' : ''}>Import ${plural(x.items.length, 'character')}</button></div></div>`;
  }
  if (x.kind === 'season') {
    const results = (x.rounds || []).reduce((s, r) => s + r.res.length, 0);
    return `<header><div><h2>Import a season</h2><p>${esc(seriesDoc(x.sid || 'f1').name)}, ${esc(x.name || '')}: ${x.status === 'current' ? 'this season’s engines and dates only' : 'a past season, catalogued'}.</p></div><button class="btn ghost" data-act="close-drawer">Close</button></header>
      <div class="body">${probs}${(x.warn || []).length ? `<p class="small muted">${x.warn.map(esc).join(' ')}</p>` : ''}
      <div class="metrics"><div class="metric"><b>${(x.rounds || []).filter(r => r.session === 'gp').length}</b><span>Grands Prix</span></div><div class="metric"><b>${(x.rounds || []).filter(r => r.session === 'sprint').length}</b><span>Sprints</span></div><div class="metric"><b>${results}</b><span>Results</span></div><div class="metric"><b>${(x.newDrivers || []).length}</b><span>New drivers</span></div></div>
      ${x.engine ? `<p>Engines: <b>${esc(ENGINE_FORMULAS[x.engine].label)}</b>.</p>` : ''}
      ${(x.newDrivers || []).length ? `<p class="small">Added to the record as drivers: ${x.newDrivers.map(esc).join(', ')}.</p>` : ''}
      ${x.status === 'archived' ? '<p class="muted small">It becomes a catalogued season: on the Seasons page, in Teams’ previous championships, and in the all-time and career standings. Importing a season with the same name again replaces it.</p>' : ''}
      <div class="btn-row"><button class="btn primary" data-act="io-season-run" ${bad ? 'disabled' : ''}>${x.status === 'current' ? 'Update this season' : 'Import the season'}</button></div></div>`;
  }
  return '';
};

/* ---------------------------------------------------------------- where the buttons live */
const ioChCard = () => `<section class="card io-card"><h2>Import and export</h2><p class="muted small">Download characters as JSON to keep or edit, or upload a file to create them. Uploaded characters arrive as drafts; keep a character’s id in the file to update it.</p>
  <div class="btn-row"><button class="btn" data-act="io-ch-mine">Download my characters</button><label class="btn file-btn">Upload characters<input type="file" accept="application/json,.json" class="sr-only" data-change="io-ch-file"></label><button class="btn ghost" data-act="io-ch-template">Download a template</button></div></section>`;
const _charactersViewIo = ROUTES.characters.view;
ROUTES.characters.view = function () { return _charactersViewIo() + ioChCard(); };
const _seasonsViewIo = ROUTES.seasons.view;
ROUTES.seasons.view = function () {
  const sid = curSeriesId(), ss = seriesSeasons(sid);
  return _seasonsViewIo() + `<section class="card io-card"><h2>Seasons as JSON</h2><p class="muted small">Download any season with every result. ${S.isGm ? 'Upload a past season to add it to the history, or a file for this season to set its engines and round dates.' : ''}</p>
    <div class="btn-row"><label class="sr-only" for="io-season-pick">Season</label><select id="io-season-pick" data-change="io-season-pick">${ss.map(s => `<option value="${esc(s.id)}" ${s.id === (S.ui.ioSeason || curSeasonId(sid)) ? 'selected' : ''}>${esc(s.name)}${s.id === curSeasonId(sid) ? ' (this season)' : s.imported ? ' (imported)' : ''}</option>`).join('')}</select>
      <button class="btn" data-act="io-season-down">Download the season</button>${S.isGm ? '<label class="btn file-btn">Upload a season<input type="file" accept="application/json,.json" class="sr-only" data-change="io-season-file"></label><button class="btn ghost" data-act="io-season-template">Download a template</button>' : ''}</div></section>`;
};
const _controlViewIo = ROUTES.control.view;
ROUTES.control.view = function () {
  return _controlViewIo() + `<section class="card io-card"><h2>Characters as JSON</h2><p class="muted small">Download every character, or upload a file: as drafts, or approved with the ratings in the file (handy for established drivers).</p>
    <div class="btn-row"><button class="btn" data-act="io-ch-all">Download all characters</button><label class="btn file-btn">Upload characters<input type="file" accept="application/json,.json" class="sr-only" data-change="io-ch-file"></label><button class="btn ghost" data-act="io-ch-template">Download a template</button></div></section>`;
};

/* =====================================================================
   F1 SIM — Home, and connections on the character sheet.
   Players: the current race weekend (or the next one) at the top, then
   their character sheet. Race Control and moderators: a dashboard with
   the weekend's state and the next step, who still has to plan, what's
   waiting for approval, the grid, the season, Discord and recent
   activity. Race Control members with a character can switch to the
   player view. Connections sit at the bottom of every character sheet.
   ===================================================================== */
'use strict';

/* ---------------------------------------------------------------- connections on the character sheet */
ACTIONS['conn-add-for'] = d => {
  const c = get('characters', d.cid), f = S.ui.form.conn || {}; if (!c || !(c.userId === S.uid || S.isGm)) return;
  if (!f.otherId) { toast('Choose who the connection is with.', true); return; }
  if (f.otherId === f1PcId(c.id)) { toast('That’s them.', true); return; }
  run(async () => { await Data.put('f1_relations', newId('rel'), { userId: c.userId, charId: c.id, personId: f1PcId(c.id), otherId: f.otherId, kind: f.kind || 'friend', note: String(f.note || '').trim().slice(0, 600), at: nowIso() }); S.ui.form.conn = { kind: f.kind || 'friend' }; }, 'Connection added.');
  S.ui.connOpen = false;
};
ACTIONS['conn-jump'] = () => { S.ui.connOpen = true; render(); setTimeout(() => { const el = document.querySelector('.conn-add'); if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); const s = el.querySelector('select'); if (s) s.focus(); } }, 60); };
function connectionsSheetHtml(p, c) {
  if (!p) return '';
  const own = !!(c && (c.userId === S.uid || S.isGm)), first = (p.name || '').split(' ')[0];
  const rels = list('f1_relations').filter(r => (r.personId === p.id || r.otherId === p.id) && F1.person(r.personId === p.id ? r.otherId : r.personId));
  const rivals = typeof trackRivals === 'function' ? trackRivals(p.id) : [];
  const groups = REL_GROUPS.map(g => [g, rels.filter(r => relGroupOf(r.kind)[0] === g[0])]).filter(x => x[1].length);
  const f = S.ui.form.conn = S.ui.form.conn || { kind: 'friend' };
  if (!groups.length && !rivals.length && !own) return '';
  return `<section class="card conn-sheet"><div class="conn-sheet-head"><h2>Connections</h2><button class="btn small ghost" data-act="nav" data-route="connections">The paddock’s connections map</button></div>
    ${groups.length ? `<div class="conn-groups">${groups.map(([g, rs]) => `<div class="conn-group"><h3><span class="conn-dot" style="background:${g[2]}"></span>${esc(g[1])}</h3><ul class="conn-list">${rs.map(r => { const mine = r.personId === p.id, other = mine ? r.otherId : r.personId;
        return `<li class="conn-row"><span></span><div>${mine ? `<b>${esc(relKindName(r.kind))}:</b> ${careerLink(other, personName(other))}` : `${careerLink(other, personName(other))} counts ${esc(first)} as a <b>${esc(relKindName(r.kind).toLowerCase())}</b>`}${r.note ? `<p class="muted small">${esc(r.note)}</p>` : ''}</div>${mine && own ? `<button class="btn small ghost" data-act="conn-remove" data-id="${esc(r.id)}">Remove</button>` : ''}</li>`; }).join('')}</ul></div>`).join('')}</div>` : `<p class="muted">No connections yet.</p>`}
    ${rivals.length ? `<h3>On track</h3><ul class="conn-list">${rivals.map(r => `<li class="conn-row"><span></span><div>${careerLink(r.personId, r.name)} <span class="muted small">${r.won} passes for, ${r.lost} against</span></div></li>`).join('')}</ul>` : ''}
    ${own && c ? `<details class="conn-add" ${S.ui.connOpen || f.otherId || f.note || (f.kind && f.kind !== 'friend') ? 'open' : ''}><summary><b>Add a connection</b></summary><div class="form-grid">
      <label class="field">Who${sel(`conn-other-${c.id}`, 'ui/form/conn/otherId', f.otherId || '', connPeople().filter(x => x.id !== p.id).map(x => [x.id, x.name + (x.charId ? '' : ' (real driver)')]), 'Choose someone')}</label>
      <label class="field">What they are to ${esc(first)}<select id="conn-kind-${esc(c.id)}" data-bind="ui/form/conn/kind">${REL_GROUPS.map(([, gl, , ks]) => `<optgroup label="${esc(gl)}">${ks.map(([k, l]) => `<option value="${k}" ${f.kind === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}</optgroup>`).join('')}</select></label></div>
      <label class="field">The story (optional)<textarea id="conn-note-${esc(c.id)}" rows="2" maxlength="600" data-bind="ui/form/conn/note">${esc(f.note || '')}</textarea></label>
      <div class="btn-row"><button class="btn primary" data-act="conn-add-for" data-cid="${esc(c.id)}">Add the connection</button></div></details>` : ''}</section>`;
}

/* ---------------------------------------------------------------- shared pieces */
const roundLabel = (w, t) => w.session === 'test' ? 'Pre-season testing' : `Round ${t.round || ''}${w.session === 'sprint' ? ', sprint' : ''}`;
function stageWords(w) {
  const st = w.state;
  if (w.status === 'practice') { const n = endedSessions(w).length, N = sessionsOf(w); return n < N ? `${sessionName(w, n + 1)} is next (${n} of ${N} ${w.session === 'test' ? 'days' : 'sessions'} run)` : (w.session === 'test' ? 'All test days run' : 'Practice done: qualifying is next'); }
  if (w.status === 'quali') return `Qualifying: Q${w.qualiStage || 1}`;
  if (st && st.finished) return 'Race finished';
  if (st && st.lap > 0) return `Race: lap ${st.lap} of ${st.laps}${st.sc && st.sc.type ? (st.sc.type === 'sc' ? ', safety car' : ', virtual safety car') : ''}`;
  return 'The grid is set: the race is next';
}
function lastGp() { return F1.weekends().filter(w => w.status === 'finished' && w.session === 'gp').sort((a, b) => String(b.finishedAt).localeCompare(String(a.finishedAt)))[0]; }
function podiumMini(w) {
  if (!w) return ''; const t = F1.track(w.trackId) || {};
  return `<div class="home-podium"><p class="muted small">Last time out: ${esc(t.name || '')}</p><ol>${(w.results || []).filter(r => r.position && r.position <= 3).sort((a, b) => a.position - b.position).map(r => `<li><span class="f1-bar" style="background:${esc(f1Colour(r.teamId))}"></span>${esc(r.name)}</li>`).join('')}</ol></div>`;
}
function nextWeekendHtml(gm) {
  const next = f1NextTrack(), s = curSeries(), date = next && (s.dates || {})[next.id];
  return `<section class="card home-wk"><p class="eyebrow">Next up</p><h2>${next ? `${esc(next.flag || '')} ${esc(next.name)}` : 'No rounds left this season'}</h2>
    <p>${next ? `Round ${esc(next.round)} · ${esc(next.circuit || '')} · ${next.laps} laps${date ? ` · ${esc(fmtDay(date))}` : ''}` : ''}</p>
    <p class="muted">${gm ? 'Open the weekend when the players are ready.' : 'Race Control opens the weekend; you’ll get a notification.'}</p>
    ${podiumMini(lastGp())}
    <div class="btn-row">${gm && next ? '<button class="btn primary" data-act="nav" data-route="weekend">Open the weekend</button>' : '<button class="btn" data-act="nav" data-route="calendar">The calendar</button>'}</div></section>`;
}

/* ---------------------------------------------------------------- the player's Home */
function playerWeekendHtml(c) {
  const w = F1.live(); if (!w) return nextWeekendHtml(false);
  const t = F1.track(w.trackId) || { name: w.trackId }, cars = c ? myWeekendCars(w) : [], ent = cars[0] ? entWithV3(cars[0]) : null, col = ent ? f1Colour(ent.teamId) : 'var(--red)';
  const todo = !ent ? 'Follow it live on the Race Weekend page.' : w.status === 'practice' ? (w.session === 'test' ? 'Plan your car’s test runs before Race Control runs the next day.' : 'Plan your car’s runs before Race Control runs the next session.')
    : w.status === 'quali' ? 'Qualifying is under way: watch the times come in.' : w.state && w.state.lap > 0 ? 'The race is on: your pit wall has the calls.' : 'Check your race plan and triggers before the start.';
  return `<section class="card home-wk" style="--team:${esc(col)}">
    <div class="home-wk-head"><div><p class="eyebrow">${esc(roundLabel(w, t))} · ${esc(stageWords(w))}</p><h2>${esc(t.flag || '')} ${esc(t.name)}${w.session === 'sprint' ? ' Sprint' : w.session === 'test' ? ' testing' : ''}</h2>
      ${ent ? `<p>${esc(ent.name)} · ${esc(F1.team(ent.teamId).name)}, car ${esc((ent.car || 1))}</p>` : ''}</div>${ent ? statStripHtml(w, ent) : ''}</div>
    ${typeof lvStagesHtml === 'function' ? lvStagesHtml(w) : ''}
    <p class="home-todo"><b>Now:</b> ${esc(ent && c && typeof involveOf === 'function' && involveOf(c.id) === 'none' ? 'Nothing: you’re hands-off, so your car runs on defaults. Watch it live.' : ent && c && typeof involveOf === 'function' && involveOf(c.id) === 'setup' && w.status !== 'practice' ? 'Nothing: the race strategy is automatic on set-up only. Watch it live.' : todo)}</p>
    ${c && ent && typeof involveBarHtml === 'function' ? involveBarHtml(c, true) : ''}
    <div class="btn-row"><button class="btn primary" data-act="nav" data-route="weekend">${ent ? 'Go to your pit wall' : 'Watch the weekend'}</button><button class="btn" data-act="nav" data-route="calendar">The calendar</button></div></section>`;
}
function playerAlertsHtml(c) {
  const out = [];
  if (charStatus(c) !== 'approved') out.push(`Application: <b>${esc(STATUS_TEXT[charStatus(c)].toLowerCase())}</b>. <button class="btn small" data-act="char-open" data-id="${esc(c.id)}">Open it</button>`);
  if (typeof f1ContractOffersFor === 'function' && f1ContractOffersFor(c.id).length) out.push(`<b>${plural(f1ContractOffersFor(c.id).length, 'contract offer')}</b> waiting. <button class="btn small" data-act="char-open" data-id="${esc(c.id)}">See it</button>`);
  const week = Date.now() - 7 * 864e5;
  list('f1_applications').filter(x => x.charId === c.id && (x.status === 'pending' || ((x.status === 'approved' || x.status === 'declined' || x.status === 'rejected') && Date.parse(x.decidedAt || x.createdAt) > week)))
    .sort((x, y) => String(y.createdAt).localeCompare(String(x.createdAt))).slice(0, 3).forEach(x => { const st = get('f1_seats', x.seatId) || { role: x.role, car: '' }, t = F1.team(x.teamId) || {};
      out.push(`Application for ${esc(seatTitle(st).toLowerCase())} at ${esc(t.name || '')}: <b>${x.status === 'pending' ? 'waiting for Race Control' : x.status === 'approved' ? 'accepted' : 'turned down'}</b>. ${x.status === 'pending' ? `<button class="btn small" data-act="nav" data-route="grid">The Grid</button>` : ''}`); });
  if (charStatus(c) === 'approved' && !charSeat(c.id) && PREF_ROLES.indexOf(c.role) !== -1) out.push('No seat yet. <button class="btn small" data-act="nav" data-route="grid">Find an open seat</button>');
  return out.length ? `<div class="home-alerts">${out.map(x => `<p>${x}</p>`).join('')}</div>` : '';
}
function playerHomeHtml(c) {
  if (!c) return `<div class="page-head"><div><p class="eyebrow">${esc(curSeries().name)}, ${esc(curSeason().name)} season</p><h1>Welcome to the paddock</h1></div></div>${playerWeekendHtml(null)}${charPromptHtml()}`;
  const prev = S.ui.career; let sheet = ''; S.ui.career = f1PcId(c.id);
  try { sheet = ROUTES.career.view().replace('<button class="linkish small" data-act="nav" data-route="people">All characters</button>', ''); } catch (e) { sheet = `<p class="muted">The character sheet couldn’t be shown: ${esc(e.message || e)}</p>`; } finally { S.ui.career = prev; }
  return `<div class="page-head"><div><p class="eyebrow">${esc(curSeries().name)}, ${esc(curSeason().name)} season</p><h1>Welcome back, ${esc(c.name.split(' ')[0])}</h1></div></div>
    ${playerLimited() ? '<section class="card notice limited-note"><p>The rest of the site (Team HQ, Race Weekend, the Test Track, Characters and the Paddock) opens once Race Control approves your character.</p></section>' : ''}
    ${playerAlertsHtml(c)}${playerWeekendHtml(c)}
    <section class="home-sheet"><div class="home-sheet-head"><h2>Your character sheet</h2><div class="btn-row"><button class="btn small" data-act="char-open" data-id="${esc(c.id)}">${charStatus(c) === 'approved' ? 'Edit' : 'The application'}</button></div></div>${sheet}</section>`;
}

/* ---------------------------------------------------------------- Race Control's Home */
ACTIONS['home-view'] = d => { S.ui.homeView = d.v; render(); };
function rcWeekendHtml() {
  const w = F1.live(); if (!w) return nextWeekendHtml(true);
  const t = F1.track(w.trackId) || { name: w.trackId }, ents = w.entrants || f1Entrants(), players = ents.filter(e => e.charId);
  let detail = '', action = '';
  if (w.status === 'practice') {
    const n = endedSessions(w).length, N = sessionsOf(w), sess = n + 1;
    const planned = new Set(list('f1_runs').filter(r => r.weekendId === w.id && (r.session || 1) === sess).map(r => r.carId));
    const handsOff = players.filter(e => typeof involveOf === 'function' && involveOf(e.charId) === 'none'), active = players.filter(e => handsOff.indexOf(e) === -1);
    const waiting = active.filter(e => !planned.has(e.id));
    detail = n < N ? `<p><b>${active.length - waiting.length} of ${active.length}</b> player cars have planned runs for ${esc(sessionName(w, sess))}.${waiting.length ? ` Waiting on: ${waiting.map(e => esc(e.name)).join(', ')}.` : ''}${handsOff.length ? ` Hands-off (defaults): ${handsOff.map(e => esc(e.name)).join(', ')}.` : ''}</p>` : '<p>All sessions are run.</p>';
    action = n < N ? `<button class="btn primary" data-act="fp-end">Run ${esc(sessionName(w, sess))}</button>` : w.session === 'test' ? '<button class="btn primary" data-act="test-finish">Finish testing</button>' : '<button class="btn primary" data-act="f1-quali">Run qualifying</button>';
  } else if (w.status === 'quali') { detail = `<p>Q${w.qualiStage || 1} done.</p>`; action = '<button class="btn primary" data-act="f1-quali-next">Run the next session</button>'; }
  else { const st = w.state; detail = st && st.lap > 0 ? `<p>Lap ${st.lap} of ${st.laps}${w.live ? ', running live' : ', paused'}.${st.sc && st.sc.type ? ' Safety car out.' : ''}</p>` : `<p>${plural(players.length, 'player car')} on the grid. Start the race from the weekend page.</p>`; }
  return `<section class="card home-wk rc"><div class="home-wk-head"><div><p class="eyebrow">${esc(roundLabel(w, t))} · ${esc(stageWords(w))}</p><h2>${esc(t.flag || '')} ${esc(t.name)}${w.session === 'sprint' ? ' Sprint' : w.session === 'test' ? ' testing' : ''}</h2></div></div>
    ${typeof lvStagesHtml === 'function' ? lvStagesHtml(w) : ''}${detail}
    <div class="btn-row">${action}<button class="btn" data-act="nav" data-route="weekend">Weekend controls</button></div></section>`;
}
function rcHomeHtml() {
  const s = curSeries(), sea = curSeason(), done = F1.weekends().filter(w => w.status === 'finished' && w.session === 'gp').length, total = F1.tracks().length;
  const pend = list('characters').filter(c => !c.retired && charStatus(c) === 'pending').sort((a, b) => String(a.submittedAt).localeCompare(String(b.submittedAt)));
  const changes = list('characters').filter(c => !c.retired && charStatus(c) === 'approved' && careerRows(c).some(r => (r.status || 'pending') === 'pending'));
  const seatApps = list('f1_applications').filter(a => a.status === 'pending');
  const seats = list('f1_seats').filter(x => F1.teams().some(t => t.id === x.teamId)), held = seats.filter(x => x.holderCharId), st = f1Standings();
  const audit = list('audit').sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 8);
  const players = new Set(list('characters').filter(c => !c.retired).map(c => c.userId)).size;
  return `<div class="page-head"><div><p class="eyebrow">${esc(s.name)}, ${esc(sea.name)} season</p><h1>Race Control</h1><p>${done} of ${plural(total, 'round')} run · ${plural(players, 'player')} · ${plural(held.length, 'seat')} held by players</p></div>
      ${S.charId ? `<div class="seg" role="tablist" aria-label="Home"><button role="tab" aria-selected="true" data-act="home-view" data-v="rc">Race Control</button><button role="tab" aria-selected="false" data-act="home-view" data-v="player">Player view</button></div>` : ''}</div>
    <div class="season-bar" role="img" aria-label="${done} of ${total} rounds run"><span style="width:${total ? done / total * 100 : 0}%"></span></div>
    <div class="rc-home">
      <div class="rc-main">${rcWeekendHtml()}
        <section class="card"><div class="conn-sheet-head"><h2>Waiting for you ${pend.length + changes.length + seatApps.length ? `<span class="count">${pend.length + changes.length + seatApps.length}</span>` : ''}</h2><button class="btn small ghost" data-act="nav" data-route="control">Race Control page</button></div>
          ${pend.length ? `<div class="app-list">${pend.slice(0, 5).map(c => appRowHtml(c, `Sent ${fmtWhen(c.submittedAt)}`)).join('')}</div>${pend.length > 5 ? `<p class="muted small">and ${pend.length - 5} more on the Race Control page.</p>` : ''}` : '<p class="muted">No character applications waiting.</p>'}
          ${changes.length ? `<p><b>${plural(changes.length, 'character')}</b> with career seasons to check.</p>` : ''}
          ${seatApps.length ? `<p><b>${plural(seatApps.length, 'seat application')}</b> to decide. <button class="btn small" data-act="nav" data-route="control">Decide</button></p>` : ''}</section>
        <section class="card"><h2>Recent activity</h2>${audit.length ? `<ul class="activity">${audit.map(a => `<li><span class="muted small">${esc(fmtWhen(a.at))}</span> ${esc(a.summary || a.action)}${a.actor ? ` <span class="muted small">(${esc(a.actor)})</span>` : ''}</li>`).join('')}</ul>` : '<p class="muted">Nothing yet.</p>'}</section></div>
      <aside class="rc-side">
        <section class="card"><h2>The grid</h2><div class="metrics"><div class="metric"><b>${held.filter(x => x.role === 'driver').length}/${seats.filter(x => x.role === 'driver').length}</b><span>Driver seats</span></div><div class="metric"><b>${held.filter(x => x.role === 'principal').length}/${seats.filter(x => x.role === 'principal').length}</b><span>Principals</span></div><div class="metric"><b>${held.filter(x => x.role === 'engineer').length}/${seats.filter(x => x.role === 'engineer').length}</b><span>Engineers</span></div></div>
          <div class="btn-row"><button class="btn small" data-act="nav" data-route="grid">The Grid</button><button class="btn small" data-act="nav" data-route="teams">Teams</button></div></section>
        <section class="card"><h2>Championship</h2>${st.drivers.length ? `<table class="data compact"><tbody>${st.drivers.slice(0, 5).map((d, i) => `<tr><td>${i + 1}</td><td><span class="f1-bar" style="background:${esc(f1Colour(d.teamId))}"></span>${esc(d.name)}${d.charId ? ' <span class="tag player">Player</span>' : ''}</td><td class="num"><b>${d.pts}</b></td></tr>`).join('')}</tbody></table>` : '<p class="muted">No races yet.</p>'}
          <div class="btn-row"><button class="btn small" data-act="nav" data-route="standings">Standings</button><button class="btn small ghost" data-act="share-open" data-kind="drivers">Export</button></div></section>
        <section class="card"><h2>Discord</h2>${S.discordCh ? `<p class="small">Channels: ${S.discordCh.map(x => `<span class="tag">#${esc(x)}</span>`).join(' ') || 'none'}</p>` : '<p class="muted small">Not checked this visit.</p>'}${S.ui.dcErr ? `<p class="small warn-note">${esc(S.ui.dcErr)}</p>` : ''}
          <div class="btn-row"><button class="btn small" data-act="discord-check">${S.discordCh ? 'Check again' : 'Check the channels'}</button><button class="btn small ghost" data-act="share-open" data-kind="calendar">Post the calendar</button></div></section>
      </aside></div>`;
}
const _homeViewNew = ROUTES.home.view;
ROUTES.home.view = function () {
  if (!F1.teams().length || S.phase !== 'ready') return _homeViewNew();
  if (S.isGm && !(S.charId && S.ui.homeView === 'player')) return rcHomeHtml();
  const h = playerHomeHtml(currentChar());
  return S.isGm ? h.replace('</h1></div></div>', `</h1></div><div class="seg" role="tablist" aria-label="Home"><button role="tab" aria-selected="false" data-act="home-view" data-v="rc">Race Control</button><button role="tab" aria-selected="true" data-act="home-view" data-v="player">Player view</button></div></div>`) : h;
};

/* =====================================================================
   F1 SIM — managing characters (Race Control).
   An "All characters" list on the Race Control page: search, filter by
   status, open, retire or restore, and delete. Deleting asks for the
   character's name to be typed, says exactly what goes, and keeps any
   race results in the history under the character's name.
   ===================================================================== */
'use strict';

const ownerName = uid => { const m = (S.ui.members || []).find(x => (x.user_id || x.id) === uid); return m ? m.username : ''; };
function charFootprint(c) {
  const pid = f1PcId(c.id), finished = list('f1_weekends').filter(w => w.status === 'finished');
  return {
    seats: list('f1_seats').filter(s => s.holderCharId === c.id),
    apps: list('f1_applications').filter(a => a.charId === c.id),
    rels: list('f1_relations').filter(r => r.charId === c.id || r.personId === pid || r.otherId === pid),
    diary: list('f1_diary').filter(x => x.charId === c.id),
    contracts: list('f1_contracts').filter(x => x.charId === c.id),
    branding: list('f1_branding').filter(x => x.charId === c.id),
    runs: list('f1_runs').filter(x => x.charId === c.id && (get('f1_weekends', x.weekendId) || {}).status !== 'finished'),
    votes: list('f1_votes').filter(x => x.charId === c.id),
    results: finished.reduce((n, w) => n + (w.results || []).filter(r => r.personId === pid || r.charId === c.id).length, 0),
    live: !!(F1.live() && ((F1.live().entrants || f1Entrants()).some(e => e.charId === c.id || e.personId === pid || (e.personId && e.personId === f1PcId(c.id)))))
  };
}
CHANGES['chm-q'] = v => { S.ui.chmQ = v; render(); };
CHANGES['chm-status'] = v => { S.ui.chmStatus = v; render(); };
function charManageHtml() {
  if (S.ui.members === undefined && typeof loadMembers === 'function') { S.ui.members = null; setTimeout(loadMembers, 0); }
  const q = String(S.ui.chmQ || '').trim().toLowerCase(), stf = S.ui.chmStatus || 'all';
  const all = list('characters').slice().sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const rows = all.filter(c => (!q || String(c.name).toLowerCase().includes(q) || ownerName(c.userId).toLowerCase().includes(q)) && (stf === 'all' || (stf === 'retired' ? c.retired : !c.retired && charStatus(c) === stf)));
  const statusTag = c => c.retired ? '<span class="tag">Retired</span>' : `<span class="tag ${charStatus(c) === 'approved' ? 'player' : charStatus(c) === 'pending' ? 'open' : ''}">${esc(STATUS_TEXT[charStatus(c)] || charStatus(c))}</span>`;
  return `<section class="card chm"><h2>All characters <span class="count">${all.length}</span></h2>
    <div class="chm-tools"><label class="sr-only" for="chm-q">Search</label><input id="chm-q" type="search" placeholder="Search by name or player" value="${esc(S.ui.chmQ || '')}" data-change="chm-q">
      <label class="sr-only" for="chm-status">Status</label><select id="chm-status" data-change="chm-status">${[['all', 'Every status'], ['draft', 'Drafts'], ['pending', 'Waiting for Race Control'], ['returned', 'Returned'], ['approved', 'Approved'], ['retired', 'Retired']].map(([k, l]) => `<option value="${k}" ${stf === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></div>
    ${rows.length ? `<div class="scroll-x"><table class="data chm-table"><thead><tr><th>Character</th><th>Player</th><th>Role</th><th>Status</th><th>Seat</th><th class="num">Results</th><th></th></tr></thead><tbody>${rows.map(c => { const fp = charFootprint(c), seat = fp.seats[0];
      return `<tr><td><b>${esc(c.name)}</b><br><code class="muted small">${esc(c.id)}</code></td><td>${esc(ownerName(c.userId) || '–')}</td><td>${esc(charRoleName(c.role))}</td><td>${statusTag(c)}</td><td>${seat ? `${esc(F1.team(seat.teamId).name)}, ${esc(seatTitle(seat).toLowerCase())}` : '<span class="muted">–</span>'}</td><td class="num">${fp.results || '–'}</td>
        <td class="chm-acts"><button class="btn small" data-act="char-open" data-id="${esc(c.id)}">Open</button>${c.retired ? `<button class="btn small" data-act="chm-restore" data-id="${esc(c.id)}">Restore</button>` : `<button class="btn small ghost" data-act="char-retire" data-id="${esc(c.id)}">Retire</button>`}<button class="btn small danger" data-act="chdel-open" data-id="${esc(c.id)}">Delete</button></td></tr>`; }).join('')}</tbody></table></div>` : '<p class="muted">No characters match.</p>'}</section>`;
}
ACTIONS['chm-restore'] = d => { if (!S.isGm) return; const c = get('characters', d.id); if (!c) return;
  run(async () => { const doc = clone(S.store.characters[d.id]); delete doc.retired; delete doc.retiredAt; await Data.put('characters', d.id, doc); await Data.audit('character.restore', `${c.name} restored by Race Control`); }, `${c.name} restored.`); };

/* ---------------------------------------------------------------- deleting */
ACTIONS['chdel-open'] = d => { if (!S.isGm) return; S.ui.chdel = { id: d.id, typed: '' }; openDrawer('chdel'); };
DRAWERS.chdel = function () {
  const x = S.ui.chdel || {}, c = get('characters', x.id); if (!c) return '<header><div><h2>Character not found</h2></div><button class="btn ghost" data-act="close-drawer">Close</button></header>';
  const fp = charFootprint(c), owner = ownerName(c.userId), seat = fp.seats[0];
  const items = [[fp.seats.length, seat ? `Their seat (${esc(F1.team(seat.teamId).name)}, ${esc(seatTitle(seat).toLowerCase())}) becomes open` : ''], [fp.apps.length, plural(fp.apps.length, 'seat application')], [fp.rels.length, plural(fp.rels.length, 'connection')], [fp.diary.length, plural(fp.diary.length, 'diary entry', 'diary entries')], [fp.contracts.length, plural(fp.contracts.length, 'contract')], [fp.branding.length, plural(fp.branding.length, 'team branding upload')], [fp.runs.length, plural(fp.runs.length, 'planned run')], [fp.votes.length, plural(fp.votes.length, 'vote')]].filter(i => i[0]);
  return `<header><div><h2>Delete ${esc(c.name)}</h2><p>${esc(charRoleName(c.role))}${owner ? `, played by ${esc(owner)}` : ''}. This can’t be undone.</p></div><button class="btn ghost" data-act="close-drawer">Close</button></header>
    <div class="body">${fp.live ? `<div class="card notice warn"><p><b>${esc(c.name)} is in the open weekend.</b> Finish or cancel the weekend first, then delete them.</p></div>` : ''}
    <p>Deleting removes the character, their application and sheet${items.length ? ', and:' : '.'}</p>${items.length ? `<ul>${items.map(i => `<li>${i[1]}</li>`).join('')}</ul>` : ''}
    <p>${fp.results ? `Their <b>${plural(fp.results, 'race result')}</b> ${fp.results === 1 ? 'is' : 'are'} removed too, with their qualifying, timesheets and any team-role records: the standings recalculate without them. Everyone else keeps their own finishes and points.` : 'They have no race results.'} Anything in the database that refers to their ID (<code>${esc(c.id)}</code>) goes.</p>
    <p class="muted small">Posts already sent to Discord stay there.</p>
    <p class="muted small">Retiring instead keeps everything and can be undone.</p>
    <label class="field"><span>Type <b>${esc(c.name)}</b> to confirm</span><input id="chdel-typed" type="text" autocomplete="off" data-bind="ui/chdel/typed" value="${esc(x.typed || '')}"></label>
    <div class="btn-row"><button class="btn danger" data-act="chdel-run" ${fp.live ? 'disabled' : ''}>Delete permanently</button>${c.retired ? '' : `<button class="btn" data-act="char-retire" data-id="${esc(c.id)}">Retire instead</button>`}</div></div>`;
};
ACTIONS['chdel-run'] = () => {
  const x = S.ui.chdel || {}, c = get('characters', x.id); if (!S.isGm || !c) return;
  const typed = String((document.getElementById('chdel-typed') || {}).value || x.typed || '').trim();
  if (typed.toLowerCase() !== String(c.name).trim().toLowerCase()) { toast(`Type ${c.name} exactly to confirm.`, true); return; }
  const fp = charFootprint(c); if (fp.live) { toast('Finish or cancel the open weekend first.', true); return; }
  const pid = f1PcId(c.id), name = c.name;
  run(async () => {
    for (const s of fp.seats) await Data.put('f1_seats', s.id, Object.assign(clone(S.store.f1_seats[s.id]), { holderCharId: null, holderName: null, holderSince: null }));
    for (const [col, rows] of [['f1_applications', fp.apps], ['f1_relations', fp.rels], ['f1_diary', fp.diary], ['f1_contracts', fp.contracts], ['f1_branding', fp.branding], ['f1_runs', fp.runs], ['f1_votes', fp.votes]])
      for (const r of rows) await Data.remove(col, r.id);
    const p = get('f1_people', pid);
    if (p) { if (fp.results) await Data.put('f1_people', pid, Object.assign(clone(S.store.f1_people[pid]), { charId: null, deleted: true, retired: true, approved: false }));
      else await Data.remove('f1_people', pid); }
    await Data.remove('characters', c.id);
    if (S.charId === c.id) { S.charId = null; lsSet('f1sim.char', null); }
    if (S.ui.charEdit === c.id) S.ui.charEdit = null;
    await Data.audit('character.delete', `${name} deleted by Race Control${fp.results ? ` (${plural(fp.results, 'race result')} kept in the history)` : ''}`);
    closeDrawer(); S.ui.chdel = null; if (S.route === 'character' || S.route === 'career') go('control');
  }, `${name} deleted.`);
};

/* ---------------------------------------------------------------- where it shows */
const _controlViewChm = ROUTES.control.view;
ROUTES.control.view = function () { const h = _controlViewChm(); return S.isGm ? h + charManageHtml() : h; };
const _characterViewChm = ROUTES.character.view;
ROUTES.character.view = function () {
  const h = _characterViewChm(), c = get('characters', S.ui.charEdit);
  if (!S.isGm || !c) return h;
  return h + `<section class="card rc-danger"><h2>Race Control</h2><p class="muted small">Delete this character and every record of them, race results included.</p><div class="btn-row"><button class="btn danger" data-act="chdel-open" data-id="${esc(c.id)}">Delete this character</button></div></section>`;
};

/* =====================================================================
   F1 SIM — teams on approval, and transfers.
   Approving a driver, team principal or race engineer seats them too:
   the decision card offers their first-choice team's open seat (then
   their second choice, or any open seat if they're happy to go
   anywhere), and the acceptance card posted to Discord names the team.
   When Race Control moves a character from one team to another, a
   Transfer card is posted to Discord (#transfers, or the default
   channel), @mentioning the player. A switch on The Grid turns it off.
   ===================================================================== */
'use strict';

if (!DISCORD_PURPOSES.some(p => p[0] === 'transfers')) DISCORD_PURPOSES.push(['transfers', 'Transfers (moves between teams, with an @mention)', 'DISCORD_WEBHOOK_TRANSFERS']);
const teamSeriesId = tid => ((get('f1_teams', tid) || {}).seriesId || 'f1');
const SEAT_ROLE = { driver: 'driver', principal: 'principal', engineer: 'engineer' };

/* ---------------------------------------------------------------- the seat chosen on approval */
function approvalSeats(c) {
  const role = SEAT_ROLE[c.role]; if (!role) return [];
  const sid = c.teamPref && c.teamPref.first ? teamSeriesId(c.teamPref.first) : curSeriesId(), teams = list('f1_teams').filter(t => (t.seriesId || 'f1') === sid).sort((a, b) => (a.order || 0) - (b.order || 0));
  return teams.flatMap(t => list('f1_seats').filter(s => s.teamId === t.id && s.role === role).sort((a, b) => (a.car || 0) - (b.car || 0)).map(s => ({ s, t, free: !s.holderCharId || s.holderCharId === c.id })));
}
function defaultApprovalSeat(c) {
  const held = list('f1_seats').find(s => s.holderCharId === c.id && SEAT_ROLE[c.role] === s.role); if (held) return held.id;
  const opts = approvalSeats(c).filter(o => o.free), p = c.teamPref || {};
  const pick = (p.first && opts.find(o => o.t.id === p.first)) || (p.second && opts.find(o => o.t.id === p.second)) || (p.any && opts[0]);
  return pick ? pick.s.id : '';
}
const chosenApprovalSeat = c => { const f = S.ui.form.approveSeat || {}; return Object.prototype.hasOwnProperty.call(f, c.id) ? f[c.id] : defaultApprovalSeat(c); };
CHANGES['approve-seat'] = (v, d) => { S.ui.form.approveSeat = S.ui.form.approveSeat || {}; S.ui.form.approveSeat[d.id] = v; render(); };
function approvalSeatHtml(c) {
  const opts = approvalSeats(c); if (!opts.length) return '';
  const cur = chosenApprovalSeat(c), p = c.teamPref || {}, tName = id => (get('f1_teams', id) || {}).name || id;
  const why = cur && p.first && (get('f1_seats', cur) || {}).teamId === p.first ? 'their first choice' : cur && p.second && (get('f1_seats', cur) || {}).teamId === p.second ? 'their second choice (the first has no open seat)' : cur && p.any ? 'they’re happy to go to any team' : '';
  return `<label class="field approve-seat">Team and seat on approval<select id="aps-${esc(c.id)}" data-change="approve-seat" data-id="${esc(c.id)}"><option value="" ${!cur ? 'selected' : ''}>Don’t seat them yet</option>
      ${[...new Set(opts.map(o => o.t.id))].map(tid => `<optgroup label="${esc(tName(tid))}${tid === p.first ? ' (first choice)' : tid === p.second ? ' (second choice)' : ''}">${opts.filter(o => o.t.id === tid).map(o => { const h = o.s.holderCharId && o.s.holderCharId !== c.id ? get('characters', o.s.holderCharId) : null;
        return `<option value="${esc(o.s.id)}" ${cur === o.s.id ? 'selected' : ''} ${h ? 'disabled' : ''}>${esc(tName(tid))}, ${esc(seatTitle(o.s).toLowerCase())}${h ? ` (held by ${esc(h.name)})` : ''}</option>`; }).join('')}</optgroup>`).join('')}</select></label>
    <p class="muted small">${cur ? `Chosen because ${why || 'Race Control picked it'}. The acceptance post names the team.` : (p.first ? `${esc(tName(p.first))} has no open ${esc(c.role === 'driver' ? 'race seat' : charRoleName(c.role).toLowerCase() + ' post')}. Pick another, or seat them later on The Grid.` : 'No team preference. Pick a seat, or seat them later on The Grid.')}</p>`;
}
const _genApproveSeat = ACTIONS['gen-approve'];
ACTIONS['gen-approve'] = d => {
  const c = get('characters', d.id); if (!c) return _genApproveSeat(d);
  const seatId = SEAT_ROLE[c.role] ? chosenApprovalSeat(c) : '', already = seatId && (get('f1_seats', seatId) || {}).holderCharId === c.id;
  if (!seatId || already) return _genApproveSeat(d);
  const pa = S.ui.form.postAccept = S.ui.form.postAccept || {}, post = pa[d.id] !== false;
  pa[d.id] = false;                                   /* post after seating, so the card names the team */
  _genApproveSeat(d);
  waitFor(() => charStatus(get('characters', d.id) || {}) === 'approved', 15000).then(async ok => {
    pa[d.id] = post; if (!ok) return;
    try { S.ui.noTransferPost = true; await f1Assign(seatId, d.id); } catch (e) { toast(`Approved, but the seat couldn’t be filled: ${e.message || e}`, true); } finally { S.ui.noTransferPost = false; }
    if (!post) return;
    const ch = await postAcceptance(d.id).catch(e => { toast(`Approved and seated, but the Discord post didn’t go: ${e.message || e}`, true); return null; });
    if (ch) { const cc = get('characters', d.id), r = S.discordLast || {}, seat = get('f1_seats', seatId);
      toast(`Approved and seated at ${F1.team(seat.teamId).name}. Acceptance card posted to #${ch}${cc && cc.discord ? (r.mentioned ? `, pinging @${cc.discord}` : `, with @${cc.discord} as text`) : ''}.`); }
  });
};

/* ---------------------------------------------------------------- transfers */
const transfersOn = () => lsGet('f1sim.postTransfers') !== 'off';
CHANGES['transfer-toggle'] = (v, d, el) => { lsSet('f1sim.postTransfers', el && el.checked ? 'on' : 'off'); render(); };
const _f1AssignTransfer = f1Assign;
f1Assign = async function (seatId, charId) {
  const seat = get('f1_seats', seatId);
  const prev = charId && seat ? list('f1_seats').find(s => s.holderCharId === charId && s.id !== seatId && teamSeriesId(s.teamId) === teamSeriesId(seat.teamId)) : null;
  const prevCopy = prev ? clone(prev) : null;
  await _f1AssignTransfer(seatId, charId);
  if (prevCopy && seat && prevCopy.teamId !== seat.teamId && S.isGm && transfersOn() && !S.ui.noTransferPost) {
    const c = get('characters', charId); if (!c || charStatus(c) !== 'approved') return;
    await Data.audit('character.transfer', `${c.name}: transfer from ${F1.team(prevCopy.teamId).name} to ${F1.team(seat.teamId).name}`);
    postTransfer(charId, prevCopy, seat).then(ch => { const r = S.discordLast || {}; toast(`Transfer posted to Discord #${ch}${c.discord ? (r.mentioned ? `, pinging @${c.discord}` : `, with @${c.discord} as text`) : ''}.`); })
      .catch(e => toast(`The move is done, but the transfer post didn’t go: ${e.message || e}`, true));
  }
};
const seatLine = (seat, c) => seat.role === 'driver' ? `driver${c && c.number ? `, car #${c.number}` : seat.car ? `, car ${seat.car}` : ''}` : seat.role === 'principal' ? 'team principal' : `race engineer${seat.car ? `, car ${seat.car}` : ''}`;
function transferText(c, from, to) { return `🔁 **Transfer:** ${c.name} moves from **${F1.team(from.teamId).name}** to **${F1.team(to.teamId).name}** as ${seatLine(to, c)}.`; }
async function postTransfer(cid, from, to) {
  const c = get('characters', cid), blob = await drawTransferCard(cid, from, to);
  return discordSend('transfers', Object.assign({ content: transferText(c, from, to) }, c.discord ? { mention_username: c.discord } : {}), { blob, name: `${fileSafe(c.name)}-transfer.png` });
}
async function drawTransferCard(cid, from, to) {
  const c = get('characters', cid), d = sheetData(cid), W = 1080, H = 1350, cv = document.createElement('canvas'); cv.width = W; cv.height = H; const g = cv.getContext('2d');
  try { await Promise.all(['700 200px "Titillium Web"', '600 40px "Titillium Web"'].map(f => document.fonts.load(f))); } catch (e) { /* fall back */ }
  const T = EXP_THEMES.dark, img = await loadImg(c.portraitUrl), logo = await loadImg(leagueLogo()), fromT = F1.team(from.teamId), toT = F1.team(to.teamId), cf = f1Colour(from.teamId), ct = f1Colour(to.teamId);
  g.fillStyle = '#1C1D22'; g.fillRect(0, 0, W, H);
  const grad = g.createLinearGradient(0, 0, W, H); grad.addColorStop(0, cf); grad.addColorStop(0.42, '#1C1D22'); grad.addColorStop(0.58, '#1C1D22'); grad.addColorStop(1, ct); g.globalAlpha = 0.8; g.fillStyle = grad; g.fillRect(0, 0, W, H); g.globalAlpha = 1;
  drawMark(g, 64, 64, Object.assign({}, T, { ink: '#FFFFFF' }), logo);
  const label = 'Transfer'; g.font = cond(700, 50); const lw = g.measureText(label).width + 44; g.fillStyle = '#E10600'; g.beginPath(); g.moveTo(74, 140); g.lineTo(64 + lw + 10, 140); g.lineTo(64 + lw, 210); g.lineTo(64, 210); g.closePath(); g.fill();
  g.fillStyle = '#FFFFFF'; g.fillText(label, 86, 193);
  const px = 270, py = 250, pw = 540, ph = 580; drawPhoto(g, img, px, py, pw, ph, 10, { name: c.name }, T);
  const fade = g.createLinearGradient(0, py + ph - 200, 0, py + ph); fade.addColorStop(0, 'rgba(28,29,34,0)'); fade.addColorStop(1, 'rgba(28,29,34,0.95)'); g.fillStyle = fade; g.fillRect(px, py + ph - 200, pw, 200);
  const parts = String(c.name).split(' '), last = parts.pop(), first = parts.join(' ');
  g.textAlign = 'center'; g.fillStyle = '#FFFFFF'; g.font = cond(600, 52); g.fillText(first, W / 2, 900);
  let size = 130; g.font = cond(700, size); while (g.measureText(last.toUpperCase()).width > W - 120 && size > 64) { size -= 6; g.font = cond(700, size); } g.fillText(last.toUpperCase(), W / 2, 900 + size * 0.9);
  /* From → to */
  const y = 1080, bw = 400, bh = 120, gap = 120, x1 = W / 2 - gap / 2 - bw, x2 = W / 2 + gap / 2;
  [[x1, 'FROM', fromT.name, cf], [x2, 'TO', toT.name, ct]].forEach(([x, k, n, col]) => {
    g.fillStyle = 'rgba(37,39,45,0.95)'; g.fillRect(x, y, bw, bh); g.fillStyle = col; g.fillRect(x, y, 12, bh);
    g.textAlign = 'left'; g.fillStyle = 'rgba(255,255,255,0.7)'; g.font = bodyF(600, 24); g.fillText(k, x + 34, y + 42);
    g.fillStyle = '#FFFFFF'; fitText(g, n, z => cond(700, z), 52, bw - 50); g.fillText(n, x + 34, y + 98); });
  g.fillStyle = '#FFFFFF'; g.beginPath(); const ax = W / 2 - 34, ay = y + bh / 2; g.moveTo(ax, ay - 8); g.lineTo(ax + 40, ay - 8); g.lineTo(ax + 40, ay - 26); g.lineTo(ax + 70, ay); g.lineTo(ax + 40, ay + 26); g.lineTo(ax + 40, ay + 8); g.lineTo(ax, ay + 8); g.closePath(); g.fill();
  g.textAlign = 'center'; g.font = cond(600, 36); g.fillStyle = 'rgba(255,255,255,0.9)'; g.fillText(seatLine(to, c).replace(/^./, m => m.toUpperCase()), W / 2, 1258);
  g.font = bodyF(500, 24); g.fillStyle = 'rgba(255,255,255,0.65)'; g.fillText(`${(d && d.series) || seriesDoc(teamSeriesId(to.teamId)).name} · ${stampText()}`, W / 2, 1300); g.textAlign = 'left';
  return new Promise(ok => cv.toBlob(ok, 'image/png'));
}
/* The switch on The Grid. */
const _gridViewTransfers = ROUTES.grid.view;
ROUTES.grid.view = function () {
  const h = _gridViewTransfers(); if (!S.isGm) return h;
  const bar = `<div class="transfer-bar"><label class="small"><input type="checkbox" data-change="transfer-toggle" ${transfersOn() ? 'checked' : ''}> Post a transfer card to Discord when I move a character to another team</label></div>`;
  const i = h.indexOf('</div></div>'); return i < 0 ? bar + h : h.slice(0, i + 12) + bar + h.slice(i + 12);
};

/* =====================================================================
   F1 SIM — careers and standings beyond drivers.
   Each finished race keeps who ran each team (principal) and each car
   (race engineer), so F1 SIM credits them with their team's or car's
   results. Career seasons have a role: in a team role, the wins,
   podiums and championship are the team's results. The Championship's
   all-time and career views get Drivers, Team principals, Race
   engineers and Other roles. JSON uploads update existing characters
   (matched by id or by name) and merge career seasons.
   ===================================================================== */
'use strict';

/* ---------------------------------------------------------------- who ran each team in a race */
function weekendStaff(w) {
  const out = {}, teams = [...new Set((w.entrants || f1Entrants()).map(e => e.teamId))];
  const who = s => s && s.holderCharId ? { charId: s.holderCharId, personId: f1PcId(s.holderCharId) } : s && s.defaultPersonId ? { charId: null, personId: s.defaultPersonId } : null;
  teams.forEach(tid => { const seats = list('f1_seats').filter(s => s.teamId === tid), eng = {};
    seats.filter(s => s.role === 'engineer').forEach(s => { const x = who(s); if (x) eng[s.car || 1] = x; });
    out[tid] = { principal: who(seats.find(s => s.role === 'principal')), engineers: eng }; });
  return out;
}
const staffPid = x => x && (x.charId ? f1PcId(x.charId) : x.personId);
/* F1 SIM records for principals (team results) or race engineers (their car's results). */
function staffStats(sidFilter, role) {
  const m = new Map(), at = (pid, x) => { const o = m.get(pid) || { pid, charId: x.charId || null, name: (F1.person(pid) || {}).name || pid, seasons: new Set(), races: 0, wins: 0, podiums: 0, pts: 0, titles: [], series: new Set() }; m.set(pid, o); return o; };
  const ws = list('f1_weekends').filter(w => w.status === 'finished' && w.staff && w.session !== 'test' && (!sidFilter || wSeries(w) === sidFilter));
  ws.forEach(w => Object.keys(w.staff).forEach(tid => { const st = w.staff[tid] || {};
    const holders = role === 'principal' ? (st.principal ? [[st.principal, (w.results || []).filter(r => r.teamId === tid)]] : [])
      : Object.keys(st.engineers || {}).map(car => [st.engineers[car], (w.results || []).filter(r => r.teamId === tid && String(r.car || 1) === String(car))]);
    holders.forEach(([x, rs]) => { const pid = staffPid(x); if (!pid) return; const o = at(pid, x);
      o.seasons.add(`${wSeries(w)}|${wSeason(w)}`); o.series.add(seriesDoc(wSeries(w)).name);
      if (w.session !== 'sprint') { o.races += 1; o.wins += rs.filter(r => r.position === 1).length; o.podiums += rs.filter(r => r.position && r.position <= 3).length; }
      o.pts += rs.reduce((s, r) => s + (r.points || 0), 0); }); }));
  /* Titles: the principal of the champion team, or the engineer on the champion's car, at the season's last race. */
  [...new Set(ws.map(w => `${wSeries(w)}|${wSeason(w)}`))].forEach(k => { const [sid, sea] = k.split('|'); if (!seasonDone(sea)) return;
    const st = standingsFor(sid, sea), last = ws.filter(w => wSeries(w) === sid && wSeason(w) === sea).sort((a, b) => String(b.finishedAt).localeCompare(String(a.finishedAt)))[0]; if (!last) return;
    const label = `${seriesDoc(sid).short || seriesDoc(sid).name} ${seasonDoc(sea).name}`;
    if (role === 'principal' && st.teams[0]) { const x = (last.staff[st.teams[0].teamId] || {}).principal, pid = staffPid(x); if (pid && m.get(pid)) m.get(pid).titles.push(label); }
    if (role === 'engineer' && st.drivers[0]) { const r = (last.results || []).find(rr => rr.personId === st.drivers[0].personId); const x = r && ((last.staff[r.teamId] || {}).engineers || {})[r.car || 1], pid = staffPid(x); if (pid && m.get(pid)) m.get(pid).titles.push(label); }
  });
  return [...m.values()].sort((a, b) => b.titles.length - a.titles.length || b.wins - a.wins || b.podiums - a.podiums || b.pts - a.pts);
}

/* ---------------------------------------------------------------- wins and podiums, by role */
function winsByRole(p, c) {
  const groups = {}, add = (role, k, o) => { const g = groups[role] = groups[role] || new Map(); const x = g.get(k) || { name: k, seasons: 0, titles: 0, wins: 0, podiums: 0, best: 99 };
    x.seasons += o.s || 1; x.titles += o.t; x.wins += o.w; x.podiums += o.p; x.best = Math.min(x.best, o.b || 99); g.set(k, x); };
  careerRows(c).filter(r => r.status === 'canon').forEach(r => add(r.role || 'driver', seriesLabel(r), { t: String(r.pos) === '1' ? 1 : 0, w: Number(r.wins) || 0, p: Number(r.podiums) || 0, b: Number(r.pos) || 99 }));
  if (p) {
    simSeasons(p.id).forEach(o => add('driver', `F1 SIM: ${o.seriesName}`, { t: o.done && o.pos === 1 ? 1 : 0, w: o.wins, p: o.podiums, b: o.pos }));
    ['principal', 'engineer'].forEach(role => { const o = staffStats(null, role).find(x => x.pid === p.id);
      if (o) add(role, `F1 SIM: ${[...o.series].join(', ')}`, { s: o.seasons.size, t: o.titles.length, w: o.wins, p: o.podiums }); });
  }
  const out = {}; Object.keys(groups).forEach(k => { out[k] = [...groups[k].values()].sort((a, b) => b.titles - a.titles || b.wins - a.wins || b.podiums - a.podiums); });
  return out;
}
winsByChampionship = function (p, c) { return winsByRole(p, c).driver || []; };
const ROLE_HEAD = { driver: 'As a driver', principal: 'As team principal (the team’s results)', director: 'As sporting director (the team’s results)', engineer: 'As race engineer (their car’s results)', strategist: 'As strategist (the team’s results)', consultant: 'As consultant (the team’s results)', other: 'In other team roles (the team’s results)' };
winsHtml = function (p, c) {
  const by = winsByRole(p, c), order = ['driver', 'principal', 'director', 'engineer', 'strategist', 'consultant', 'other'].filter(k => (by[k] || []).length);
  if (!order.length) return '';
  const table = (rows, team) => { const maxP = Math.max(1, ...rows.map(x => x.podiums)), tot = rows.reduce((s, x) => ({ t: s.t + x.titles, w: s.w + x.wins, p: s.p + x.podiums }), { t: 0, w: 0, p: 0 });
    return `<div class="metrics"><div class="metric"><b>${tot.t}</b><span>${team ? 'Team titles' : tot.t === 1 ? 'Title' : 'Titles'}</span></div><div class="metric"><b>${tot.w}</b><span>${team ? 'Team wins' : 'Wins'}</span></div><div class="metric"><b>${tot.p}</b><span>${team ? 'Team podiums' : 'Podiums'}</span></div><div class="metric"><b>${rows.length}</b><span>${rows.length === 1 ? 'Championship' : 'Championships'}</span></div></div>
      <div class="scroll-x"><table class="data"><thead><tr><th>Championship</th><th class="num">Seasons</th><th class="num">${team ? 'Team titles' : 'Titles'}</th><th class="num">Wins</th><th class="num">Podiums</th><th class="bars-h">Wins and podiums</th><th>Best</th></tr></thead><tbody>
      ${rows.map(x => `<tr><td><b>${esc(x.name)}</b></td><td class="num">${x.seasons}</td><td class="num">${x.titles ? `<span class="tag trophy">${x.titles}</span>` : 0}</td><td class="num">${x.wins}</td><td class="num">${x.podiums}</td>
        <td><div class="wp-bar" role="img" aria-label="${x.wins} wins and ${x.podiums} podiums"><span class="p" style="width:${x.podiums / maxP * 100}%"></span><span class="w" style="width:${x.wins / maxP * 100}%"></span></div></td>
        <td>${x.best === 1 && x.titles ? 'Champion' : x.best < 99 ? ordinal(x.best) : '–'}</td></tr>`).join('')}</tbody></table></div>`; };
  return `<section class="card wins-champ"><h2>Wins and podiums by championship</h2>
    ${order.map(k => `${order.length > 1 || k !== 'driver' ? `<h3 class="wins-role">${esc(ROLE_HEAD[k])}</h3>` : ''}${table(by[k], k !== 'driver')}`).join('')}
    <p class="muted small"><span class="key w"></span> wins <span class="key p"></span> podiums. F1 SIM races count automatically; other championships come from the canon career record.</p></section>`;
};

/* ---------------------------------------------------------------- standings by role */
ACTIONS['stand-role'] = d => { S.ui.standRole = d.r; render(); };
const STAND_ROLES = [['driver', 'Drivers'], ['principal', 'Team principals'], ['engineer', 'Race engineers'], ['other', 'Other roles']];
function roleCareerData(role) {
  const people = new Map(), at = (pid, name, c) => { const o = people.get(pid) || { pid, name, c, titles: [], wins: 0, podiums: 0, champs: new Set() }; people.set(pid, o); return o; };
  if (role !== 'other') staffStats(null, role).forEach(s => { const o = at(s.pid, s.name, s.charId ? get('characters', s.charId) : null); o.titles.push(...s.titles.map(t => `F1 SIM ${t}`)); o.wins += s.wins; o.podiums += s.podiums; s.series.forEach(x => o.champs.add(`F1 SIM: ${x}`)); });
  list('characters').filter(c => !c.retired && charApproved(c)).forEach(c => careerRows(c).filter(r => r.status === 'canon' && roleGroupOf(r.role) === role).forEach(r => {
    const o = at(f1PcId(c.id), c.name, c); if (String(r.pos) === '1') o.titles.push(`${seriesLabel(r)} ${r.years}${role === 'other' ? ` (${careerRoleName(r.role).toLowerCase()})` : ''}`);
    o.wins += Number(r.wins) || 0; o.podiums += Number(r.podiums) || 0; o.champs.add(seriesLabel(r)); }));
  return [...people.values()].sort((a, b) => b.titles.length - a.titles.length || b.wins - a.wins || b.podiums - a.podiums || a.name.localeCompare(b.name));
}
const _standingsViewRoles = ROUTES.standings.view;
ROUTES.standings.view = function () {
  const v = S.ui.standView || 'season', role = S.ui.standRole || 'driver';
  if (v === 'season') return _standingsViewRoles();
  const tabs = `<div class="seg stand-roles" role="tablist" aria-label="Who">${STAND_ROLES.map(([k, l]) => `<button role="tab" aria-selected="${role === k}" data-act="stand-role" data-r="${k}">${esc(l)}</button>`).join('')}</div>`;
  const h = role === 'driver' ? _standingsViewRoles() : roleStandingsHtml(v, role), at = h.indexOf('</div>', h.indexOf('class="seg stand-tabs"'));
  return at < 0 ? tabs + h : h.slice(0, at + 6) + tabs + h.slice(at + 6);
};
function roleStandingsHtml(v, role) {
  const sid = curSeriesId(), s = seriesDoc(sid), label = (STAND_ROLES.find(r => r[0] === role) || [])[1];
  const tabs = `<div class="seg stand-tabs" role="tablist" aria-label="Standings">${[['season', `${seasonDoc(curSeasonId(sid)).name} season`], ['alltime', 'All-time in F1 SIM'], ['career', 'Career: every championship']].map(([k, l]) => `<button role="tab" aria-selected="${v === k}" data-act="stand-view" data-v="${k}">${esc(l)}</button>`).join('')}</div>`;
  const what = role === 'principal' ? 'Team principals are credited with their team’s results while they ran it, and the constructors’ title when their team won it.' : role === 'engineer' ? 'Race engineers are credited with their car’s results, and the drivers’ title when their driver won it.' : 'Sporting directors, strategists, consultants and other team roles, from canon career seasons (the team’s results).';
  let body;
  if (v === 'alltime') {
    const rows = role === 'other' ? [] : staffStats(sid, role);
    body = rows.length ? `<section class="card"><h2>${esc(label)}</h2><div class="scroll-x"><table class="data"><thead><tr><th>Pos</th><th>Name</th><th class="num">Seasons</th><th class="num">Races</th><th class="num">Wins</th><th class="num">Podiums</th><th class="num">Points</th><th>Titles</th></tr></thead><tbody>${rows.map((o, i) => `<tr><td><b>${i + 1}</b></td><td>${careerLink(o.pid, o.name)}${o.charId ? ' <span class="tag player">Player</span>' : ''}</td><td class="num">${o.seasons.size}</td><td class="num">${o.races}</td><td class="num">${o.wins}</td><td class="num">${o.podiums}</td><td class="num"><b>${o.pts}</b></td><td>${o.titles.map(t => `<span class="tag trophy">${esc(t)}</span>`).join(' ')}</td></tr>`).join('')}</tbody></table></div></section>`
      : `<p class="muted">${role === 'other' ? 'F1 SIM seats are drivers, team principals and race engineers; other roles appear in the career view.' : 'No races recorded with them yet.'}</p>`;
  } else {
    const rows = roleCareerData(role);
    body = rows.length ? `<section class="card"><h2>${esc(label)}: career standings</h2><div class="scroll-x"><table class="data"><thead><tr><th>Pos</th><th>Name</th><th class="num">${role === 'engineer' ? 'Titles' : 'Team titles'}</th><th class="num">Wins</th><th class="num">Podiums</th><th class="num">Championships</th><th>Titles won</th></tr></thead><tbody>${rows.map((o, i) => `<tr><td><b>${i + 1}</b></td><td>${careerLink(o.pid, o.name)}${o.c ? ' <span class="tag player">Player</span>' : ''}<div class="muted small">${esc([...o.champs].join(', '))}</div></td><td class="num"><b>${o.titles.length}</b></td><td class="num">${o.wins}</td><td class="num">${o.podiums}</td><td class="num">${o.champs.size}</td><td>${o.titles.map(t => `<span class="tag trophy">${esc(t)}</span>`).join(' ')}</td></tr>`).join('')}</tbody></table></div></section>` : '<p class="muted">Nobody yet.</p>';
  }
  return `<div class="page-head"><div><h1>Championship</h1><p>${esc(what)} ${v === 'alltime' ? `${esc(s.name)}, every F1 SIM season.` : 'F1 SIM plus canon career seasons.'}</p></div></div>${tabs}${body}`;
}

/* ---------------------------------------------------------------- JSON: roles, and updating existing characters */
const _normaliseCharStaff = normaliseChar;
normaliseChar = function (x, i, problems) {
  const o = _normaliseCharStaff(x, i, problems); if (!o) return o;
  (Array.isArray(x.career) ? x.career : []).forEach((r, j) => { if (r && r.role && CAREER_ROLE_KEYS.indexOf(r.role) === -1) { problems.push(`Character ${i + 1} (${o.name}), career season ${j + 1}: role “${r.role}” isn’t one of ${CAREER_ROLE_KEYS.join(', ')}.`); } });
  if (!o.update) { const m = list('characters').find(c => String(c.name).trim().toLowerCase() === o.name.toLowerCase() && (c.userId === S.uid || S.isGm));
    if (m) { o.id = m.id; o.update = true; o.matchedBy = 'name'; } } else o.matchedBy = 'id';
  o.mode = o.update ? 'update' : 'new';
  return o;
};
const _charToJsonStaff = charToJson;
charToJson = function (c) { const o = _charToJsonStaff(c); if (o.career) o.career = o.career.map((r, k) => { const src = careerRows(c)[k] || {}; return src.role && src.role !== 'driver' ? Object.assign({ role: src.role }, r) : r; }); return o; };
CHANGES['io-item-mode'] = (v, d) => { const it = ((S.ui.io || {}).items || [])[Number(d.i)]; if (it) { it.mode = v; renderOverlay(); } };
const careerKey = r => [String(r.years || '').trim(), r.series, String(r.other || '').trim().toLowerCase(), r.role || 'driver'].join('|');
const sameRow = (a, b) => ['team', 'wins', 'podiums', 'poles', 'pos', 'notes'].every(k => String(a[k] == null ? '' : a[k]) === String(b[k] == null ? '' : b[k]));
ACTIONS['io-ch-run'] = () => {
  const x = S.ui.io; if (!x || x.kind !== 'ch' || !x.items.length) return; const approve = S.isGm && x.mode === 'approved';
  run(async () => {
    let made = 0, updated = 0, rated = 0;
    for (const it of x.items) {
      const upd = it.update && it.mode !== 'new', { update, ratings, career, mode, matchedBy, ...fields } = it;
      const id = upd ? it.id : await newCharId(), prev = upd ? get('characters', id) : null; delete fields.id;
      if (prev && charStatus(prev) === 'approved') delete fields.role;           /* an approved character keeps their role */
      const statusFor = (r, old) => S.isGm ? (approve && (r.status || 'pending') === 'pending' ? 'canon' : (r.status || (old && old.status) || 'pending')) : (old && sameRow(old, r) ? old.status : 'pending');
      let rows;
      if (prev) { rows = careerRows(prev).map(r => Object.assign({}, r));
        career.forEach(r => { const k = careerKey(r), j = rows.findIndex(o => careerKey(o) === k);
          if (j >= 0) rows[j] = Object.assign({}, rows[j], r, { id: rows[j].id, status: statusFor(r, rows[j]), at: sameRow(rows[j], r) ? rows[j].at : nowIso() });
          else rows.push(Object.assign({ id: newId('cr'), at: nowIso() }, r, { status: statusFor(r, null) })); });
      } else rows = career.map(r => Object.assign({ id: newId('cr'), at: nowIso() }, r, { status: statusFor(r, null) }));
      rows.sort((a, b) => (parseInt(a.years, 10) || 0) - (parseInt(b.years, 10) || 0));
      const doc = Object.assign({}, prev ? clone(S.store.characters[id]) : { createdAt: nowIso(), userId: S.uid, status: 'draft' }, fields, { career: rows, updatedAt: nowIso() });
      const pid = f1PcId(id), person = get('f1_people', pid);
      if (approve && !(prev && charStatus(prev) === 'approved')) {
        const base = doc.role === 'driver' ? Object.assign({}, F1_ROOKIE, ratings || {}) : {};
        await Data.put('f1_people', pid, Object.assign(base, { kind: doc.role, charId: id, name: doc.name, abbr: doc.code || f1Code(doc.name), num: doc.number || null, flag: '', approved: true, imported: true, approvedAt: nowIso() }));
        Object.assign(doc, { status: 'approved', decidedAt: nowIso(), gen: Object.assign({}, doc.gen || {}, { imported: true, style: (ratings || {}).style || 'technical' }) });
      } else if (approve && person && ratings && Object.keys(ratings).length && doc.role === 'driver') { await Data.put('f1_people', pid, Object.assign(clone(S.store.f1_people[pid]), ratings)); rated++; }
      if (person && prev && (fields.name || fields.code || fields.number)) await Data.put('f1_people', pid, Object.assign(clone(S.store.f1_people[pid] || {}), { name: doc.name, abbr: doc.code || person.abbr, num: doc.number || person.num }));
      await Data.put('characters', id, doc); if (prev) updated++; else made++;
    }
    await Data.audit('io.characters', `Imported characters: ${made} new, ${updated} updated${rated ? `, ${rated} ratings updated` : ''}${approve ? ', as approved' : ''}`);
    closeDrawer();
    toast(`${made ? `${plural(made, 'character')} created` : ''}${made && updated ? ', ' : ''}${updated ? `${plural(updated, 'character')} updated` : ''}${rated ? ` (${rated} with new ratings)` : ''}.`);
  });
};
/* The preview: say which characters update, and let each be created new instead. */
const _drawerIoStaff = DRAWERS.io;
DRAWERS.io = function () {
  const x = S.ui.io || {}; let h = _drawerIoStaff(); if (x.kind !== 'ch') return h;
  x.items.forEach((it, i) => { const tag = it.update ? '<span class="tag open">Updates yours</span>' : '<span class="tag">New</span>';
    const ctl = it.update ? `<select data-change="io-item-mode" data-i="${i}" aria-label="What to do with ${esc(it.name)}"><option value="update" ${it.mode !== 'new' ? 'selected' : ''}>Update ${esc(it.name)}${it.matchedBy === 'name' ? ' (matched by name)' : ''}</option><option value="new" ${it.mode === 'new' ? 'selected' : ''}>Create a new character</option></select>` : tag;
    h = h.replace(tag, ctl); });
  return h.replace('<option value="approved" ', '<option value="approved" title="Also updates the ratings of approved drivers in the file" ').replace('Approved, with the ratings in the file</option>', 'Approved, with the ratings in the file (updates approved drivers’ ratings too)</option>')
    + '';
};

/* =====================================================================
   F1 SIM — how involved a player is in the race sim.
   Each character picks one of three, and can change it at any time
   (the level in force at each stage is the one that counts):
     Hands-off    the car runs on defaults: standard set-up and practice,
                  the default race strategy, and driver moments settle
                  themselves straight away.
     Set-up only  practice runs and the set-up are theirs; the race
                  strategy, live calls and driver moments are automatic.
     Full         everything: set-up, race plan, live calls and moments.
   ===================================================================== */
'use strict';

const INVOLVE = [
  ['none', 'Hands-off', 'Your car runs on defaults all weekend: a standard set-up, the default race strategy, and driver moments settle themselves. Nothing to do; just watch.'],
  ['setup', 'Set-up only', 'You plan practice and choose the set-up. The race strategy, live calls and driver moments are automatic.'],
  ['full', 'Full', 'Everything: practice and set-up, the race plan and triggers, live calls from the pit wall, and driver moments.']
];
const involveOf = cid => { const c = cid ? get('characters', cid) : null; return (c && c.involve) || 'full'; };
const involveName = l => (INVOLVE.find(x => x[0] === l) || INVOLVE[2])[1];
function involveAllows(cid, what) { if (!cid) return true; const l = involveOf(cid); return what === 'setup' ? l !== 'none' : what === 'strategy' ? l === 'full' : true; }
ACTIONS['involve-set'] = d => {
  const c = get('characters', d.cid || S.charId); if (!c || !(c.userId === S.uid || S.isGm) || ['none', 'setup', 'full'].indexOf(d.v) === -1 || involveOf(c.id) === d.v) return;
  run(async () => { const doc = charDoc(c.id); doc.involve = d.v; doc.involveAt = nowIso(); await Data.put('characters', c.id, doc); await Data.audit('character.involve', `${c.name}: race involvement set to ${involveName(d.v).toLowerCase()}`); },
    `${involveName(d.v)}${d.v === 'none' ? ': your car runs on defaults.' : d.v === 'setup' ? ': you do practice and set-up; the race strategy is automatic.' : ': everything is yours.'}`);
};
function involveBarHtml(c, compact) {
  if (!c) return ''; const l = involveOf(c.id), cur = INVOLVE.find(x => x[0] === l);
  return `<div class="involve ${compact ? 'compact' : ''}"><div class="involve-head"><b>Your involvement${compact ? '' : ' this race'}</b><div class="seg" role="radiogroup" aria-label="Race involvement">${INVOLVE.map(([k, n]) => `<button role="radio" aria-checked="${l === k}" data-act="involve-set" data-cid="${esc(c.id)}" data-v="${k}">${esc(n)}</button>`).join('')}</div></div>
    ${compact ? '' : `<p class="muted small">${esc(cur[2])} Change it whenever you like, race to race or mid-weekend.</p>`}</div>`;
}

/* ---------------------------------------------------------------- what the simulation uses */
const _setupChoiceInvolve = setupChoice;
setupChoice = function (w, ent) { const ch = _setupChoiceInvolve(w, ent); return ch && ch.by && !involveAllows(ch.by, 'setup') ? null : ch; };
f1Plan = function (w, ent) {
  return list('f1_plans').filter(p => p.weekendId === w.id && p.carId === ent.id && canPlan(w, ent, p.charId) && involveAllows(p.charId, 'strategy'))
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))[0] || null;
};
const _f1NewMomentsInvolve = f1NewMoments;
f1NewMoments = function (w, st, log) {
  const ents = w.entrants || f1Entrants();
  return _f1NewMomentsInvolve(w, st, log).filter(m => { const e = ents.find(x => x.id === m.carId); return !e || !e.charId || involveAllows(e.charId, 'strategy'); });
};
const callAllowed = c => !c || !c.charId || (c.type === 'setup' ? involveAllows(c.charId, 'setup') : involveAllows(c.charId, 'strategy'));
const _f1SendCallInvolve = f1SendCall;
f1SendCall = function (call) {
  const doc = Object.assign({ charId: S.charId }, call);
  if (!callAllowed(doc)) { toast(involveOf(S.charId) === 'none' ? 'You’re hands-off this race: your car runs on defaults. Change your involvement to make calls.' : 'You’re on set-up only: the race strategy is automatic. Switch to Full to make race calls.', true); return; }
  return _f1SendCallInvolve(call);
};

/* ---------------------------------------------------------------- the pit wall */
const _weekendViewInvolve = ROUTES.weekend.view;
ROUTES.weekend.view = function () {
  const w = F1.live(), c = currentChar();
  if (!w || S.ui.f1view || !c || !(w.entrants || f1Entrants()).some(e => canPlan(w, e, c.id))) return _weekendViewInvolve();
  const l = involveOf(c.id), bar = involveBarHtml(c);
  if (l === 'none') return bar + _weekendTabs();
  return bar + _weekendViewInvolve();
};

/* =====================================================================
   F1 SIM — team cards on Discord, and the people running each team.
   A team card goes to the team's own channel if there is one
   (DISCORD_WEBHOOK_TEAM_<TEAM>), else its series' teams channel
   (DISCORD_WEBHOOK_F2_TEAMS…), else DISCORD_WEBHOOK_TEAMS, else the
   standings channel, else the default. Race Control can post every team
   of a series in one go. The Teams pages show each team's principal and
   race engineers, and the principals and engineers it has had.
   ===================================================================== */
'use strict';

if (!DISCORD_PURPOSES.some(p => p[0] === 'teams')) DISCORD_PURPOSES.push(['teams', 'Team cards (per series, or a channel per team)', 'DISCORD_WEBHOOK_TEAMS']);
const teamHookName = tid => `DISCORD_WEBHOOK_TEAM_${String(tid).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
function teamChannel(tid, list) {
  const sid = (get('f1_teams', tid) || {}).seriesId || 'f1';
  return [`team-${tid}`, `${sid}-teams`, `${sid}-team`, 'teams', 'team', `${sid}-standings`, 'standings', 'default'].find(c => list.indexOf(c) !== -1) || list[0] || 'default';
}
async function postTeamCard(tid, blob) {
  const t = get('f1_teams', tid), sid = t.seriesId || 'f1', list = await discordChannels().catch(() => ['default']);
  const b = blob || await drawTeamCard(tid);
  return discordSend('teams', { content: `**${t.name}**: ${seriesDoc(sid).name}, ${seasonDoc(curSeasonId(sid)).name} season` }, { blob: b, name: `${fileSafe(t.name)}-team-card.png` }, teamChannel(tid, list));
}
ACTIONS['tcard-discord'] = () => { const x = S.ui.tcard; if (!x || !x.blob) return;
  run(async () => { x.posted = await postTeamCard(x.tid, x.blob); await Data.audit('discord.team', `${(get('f1_teams', x.tid) || {}).name} team card posted to #${x.posted}`); }, 'Posted to Discord.'); };
const _drawerTcardDiscord = DRAWERS.tcard;
DRAWERS.tcard = function () {
  const x = S.ui.tcard || {}, t = get('f1_teams', x.tid) || {}, sid = t.seriesId || 'f1', list = S.discordCh;
  if (!S.isGm) return _drawerTcardDiscord();
  const where = list ? `It goes to <b>#${esc(teamChannel(x.tid, list))}</b>.` : 'Check the channels on the League page to see where it goes.';
  return _drawerTcardDiscord().replace('</div></div>', `</div><p class="muted small">${where} For a channel just for ${esc(t.name)}, add <code>${esc(teamHookName(x.tid))}</code>; for all ${esc(seriesDoc(sid).name)} teams, <code>DISCORD_WEBHOOK_${esc(sid.toUpperCase())}_TEAMS</code>.</p></div>`);
};
ACTIONS['teams-post-all'] = () => {
  if (!S.isGm) return; const sid = S.ui.teamsSeries || curSeriesId(), teams = list('f1_teams').filter(t => (t.seriesId || 'f1') === sid).sort((a, b) => (a.order || 0) - (b.order || 0));
  askConfirm(`Post all ${teams.length} ${seriesDoc(sid).name} team cards to Discord? Each goes to its team’s channel if it has one, else the ${seriesDoc(sid).name} teams channel.`, 'Post them', async () => {
    S.ui.teamsPosting = { done: 0, total: teams.length, fails: 0 }; render(); const chans = new Set();
    for (const t of teams) { try { chans.add(await postTeamCard(t.id)); } catch (e) { S.ui.teamsPosting.fails++; } S.ui.teamsPosting.done++; render(); await new Promise(ok => setTimeout(ok, 700)); }
    const p = S.ui.teamsPosting; S.ui.teamsPosting = null; render();
    await Data.audit('discord.teams', `${seriesDoc(sid).name}: ${p.done - p.fails} team cards posted`).catch(() => {});
    toast(p.fails ? `${p.done - p.fails} of ${p.total} posted; ${p.fails} didn’t go.` : `All ${p.total} team cards posted (${[...chans].map(c => '#' + c).join(', ')}).`, !!p.fails);
  });
};

/* ---------------------------------------------------------------- the people running each team */
function staffAt(tid, sid, sea) {
  /* The latest race of that season that recorded who ran the team. */
  const w = list('f1_weekends').filter(x => x.status === 'finished' && x.staff && x.staff[tid] && wSeries(x) === sid && wSeason(x) === sea).sort((a, b) => String(b.finishedAt).localeCompare(String(a.finishedAt)))[0];
  if (!w) return null; const st = w.staff[tid], nm = x => x ? { name: (F1.person(staffPid(x)) || {}).name || '–', player: !!x.charId } : null;
  return { principal: nm(st.principal), engineers: Object.keys(st.engineers || {}).sort().map(car => Object.assign({ car }, nm(st.engineers[car]))) };
}
function teamStaffHtml(t, sid, sea) {
  let rows;
  if (sea === curSeasonId(sid)) rows = teamLineup(t).filter(m => !/^Driver/.test(m.role)).map(m => [m.role, m.name, m.player, m.open, m.canon]);
  else { const s = staffAt(t.id, sid, sea); if (!s) return ''; rows = [['Team principal', s.principal ? s.principal.name : '–', s.principal && s.principal.player, !s.principal]].concat(s.engineers.map(e => [`Race engineer, car ${e.car}`, e.name, e.player, false])); }
  return `<span class="tm-staff">${rows.map(([r, n, pl, open, canon]) => `<span class="tm-staff-row"><span class="muted">${esc(r)}</span><b class="${open ? 'muted' : ''}">${esc(open ? 'Open' : n)}${canon ? ' <span class="muted" style="font-weight:400">(open for players)</span>' : ''}</b>${pl ? '<span class="tag player">Player</span>' : ''}</span>`).join('')}</span>`;
}
function teamStaffHistory(tid, sid) {
  const out = { principal: new Map(), engineer: new Map() };
  list('f1_weekends').filter(w => w.status === 'finished' && w.staff && w.staff[tid] && wSeries(w) === sid && w.session !== 'test').forEach(w => {
    const st = w.staff[tid], seaName = seasonDoc(wSeason(w)).name, rs = (w.results || []).filter(r => r.teamId === tid);
    const add = (role, x, results, label) => { const pid = staffPid(x); if (!pid) return; const m = out[role], o = m.get(pid) || { pid, name: (F1.person(pid) || {}).name || pid, player: !!x.charId, seasons: new Set(), races: 0, wins: 0, cars: new Set() };
      o.seasons.add(seaName); if (label) o.cars.add(label); if (w.session !== 'sprint') { o.races++; o.wins += results.filter(r => r.position === 1).length; } m.set(pid, o); };
    add('principal', st.principal, rs);
    Object.keys(st.engineers || {}).forEach(car => add('engineer', st.engineers[car], rs.filter(r => String(r.car || 1) === String(car)), `car ${car}`));
  });
  return { principal: [...out.principal.values()].sort((a, b) => b.races - a.races), engineer: [...out.engineer.values()].sort((a, b) => b.races - a.races) };
}
const _teamviewStaff = ROUTES.teamview.view;
ROUTES.teamview.view = function () {
  const h = _teamviewStaff(), t = get('f1_teams', S.ui.teamView); if (!t || (S.ui.teamTab || 'season') !== 'history') return h;
  const sh = teamStaffHistory(t.id, t.seriesId || 'f1');
  const block = (title, rows, eng) => `<h3>${esc(title)}</h3>${rows.length ? `<div class="tm-lineup">${rows.map(o => `<button class="tm-member ${o.player ? 'player' : ''}" data-act="career" data-id="${esc(o.pid)}"><span class="tm-face">${esc(initials(o.name))}</span><span><b>${esc(o.name)}</b>${o.player ? ' <span class="tag player">Player</span>' : ''}<br><small class="muted">${esc([...o.seasons].join(', '))} · ${plural(o.races, 'race')} · ${plural(o.wins, eng ? 'win for their car' : 'win', eng ? 'wins for their car' : 'wins')}${eng && o.cars.size ? ` · ${esc([...o.cars].join(', '))}` : ''}</small></span></button>`).join('')}</div>` : '<p class="muted">None recorded yet.</p>'}`;
  return h + `<section class="card"><h2>Team principals and race engineers</h2>${block('Team principals', sh.principal)}${block('Race engineers', sh.engineer, true)}<p class="muted small">Recorded from every race since who ran each team started being kept.</p></section>`;
};
const _teamsViewDiscord = ROUTES.teams.view;
ROUTES.teams.view = function () {
  const h = _teamsViewDiscord(); if (!S.isGm) return h;
  const sid = S.ui.teamsSeries || curSeriesId(), p = S.ui.teamsPosting;
  const btn = p ? `<button class="btn" disabled>Posting ${p.done} of ${p.total}…</button>` : `<button class="btn" data-act="teams-post-all">Post every ${esc(seriesDoc(sid).short || seriesDoc(sid).name)} team to Discord</button>`;
  const i = h.indexOf('</select></div>'); return i < 0 ? h : h.slice(0, i + 9) + btn + h.slice(i + 9);
};

/* =====================================================================
   F1 SIM — dates and times on exports.
   Every exported image says when it was made, in UK time (GMT or BST),
   and every Discord post says "As of" using Discord's own timestamp, so
   each reader sees it in their own time zone.
   ===================================================================== */
'use strict';

function stampText(when) {
  const d = when ? new Date(when) : new Date();
  try {
    const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZoneName: 'short' }).formatToParts(d);
    const v = k => (p.find(x => x.type === k) || {}).value || '';
    return `${v('day')} ${v('month')} ${v('year')}, ${v('hour')}:${v('minute')} ${v('timeZoneName')}`.trim();
  } catch (e) { return d.toISOString().slice(0, 16).replace('T', ', ') + ' UTC'; }
}
const _discordSendStamp = discordSend;
discordSend = function (purpose, payload, file, chosen) {
  const unix = Math.floor(Date.now() / 1000), p = Object.assign({}, payload || {});
  p.content = `${p.content ? p.content + '\n' : ''}-# As of <t:${unix}:f>`;
  return _discordSendStamp(purpose, p, file, chosen);
};

/* =====================================================================
   F1 SIM — pictures for real people, and canon people in open seats.
   Race Control can add a picture for any real driver or team principal
   (on their page, or from a team's page). Pictures are used wherever a
   face is shown: the Teams pages, the team card, timing exports and the
   character page. A real person sitting in a seat players can take is
   marked "(open for players)".
   ===================================================================== */
'use strict';

function personPic(pid, c) { return (c && c.portraitUrl) || ((pid && F1.person(pid)) || {}).portraitUrl || ''; }
CHANGES['person-portrait'] = (v, d, el) => {
  const file = el.files && el.files[0], p = get('f1_people', d.id); if (!file || !p || !S.isGm) return;
  if (!/^image\//.test(file.type)) { toast('Choose a picture: a JPEG, PNG or WebP.', true); return; }
  run(async () => {
    const blob = await shrinkImage(file, 900), assets = await window.claude.use('assets'), up = await assets.upload(blob, { type: 'image/jpeg' });
    await Data.put('f1_people', d.id, Object.assign(clone(S.store.f1_people[d.id]), { portraitUrl: up.url }));
    await Data.audit('person.picture', `Picture added for ${p.name}`);
  }, `Picture saved for ${p.name}.`);
  el.value = '';
};
ACTIONS['person-portrait-remove'] = d => { const p = get('f1_people', d.id); if (!p || !S.isGm) return;
  run(async () => { const doc = clone(S.store.f1_people[d.id]); delete doc.portraitUrl; await Data.put('f1_people', d.id, doc); }, 'Picture removed.'); };
const picControls = (pid, has) => `<label class="btn small file-btn">${has ? 'Change the picture' : 'Add a picture'}<input type="file" accept="image/*" class="sr-only" data-change="person-portrait" data-id="${esc(pid)}"></label>${has ? `<button class="btn small ghost" data-act="person-portrait-remove" data-id="${esc(pid)}">Remove</button>` : ''}`;

/* On a team's page, Race Control can add pictures for the real people in its seats. */
const _teamviewPics = ROUTES.teamview.view;
ROUTES.teamview.view = function () {
  const h = _teamviewPics(), t = get('f1_teams', S.ui.teamView); if (!t || !S.isGm || (S.ui.teamTab || 'season') !== 'season') return h;
  const canon = teamLineup(t).filter(m => m.real);
  if (!canon.length) return h;
  const box = `<details class="card pics-box"><summary><b>Pictures for real people</b> <span class="muted small">${canon.filter(m => personPic(m.pid)).length} of ${canon.length} have one</span></summary>
    <div class="pics-list">${canon.map(m => { const pic = personPic(m.pid); return `<div class="pics-row"><span class="tm-face">${pic ? `<img src="${esc(pic)}" alt="">` : esc(initials(m.name))}</span><span><b>${esc(m.name)}</b><br><small class="muted">${esc(m.role)}</small></span><div class="btn-row">${picControls(m.pid, !!pic)}</div></div>`; }).join('')}</div>
    <p class="muted small">Players’ characters use their own portraits. Pictures for real people are added by Race Control and show on the Teams pages, team cards and timing exports.</p></details>`;
  const i = h.indexOf('<section class="card"><h2>Points by round</h2>'); return i < 0 ? h + box : h.slice(0, i) + box + h.slice(i);
};
/* On a real person's page: their picture, and the controls for Race Control. */
const _careerViewPics = ROUTES.career.view;
ROUTES.career.view = function () {
  const h = _careerViewPics(), p = F1.person(S.ui.career); if (!p || p.charId || !S.isGm) return h;
  const i = h.indexOf('<div class="char-actions'), at = i >= 0 ? i : h.indexOf('</div></div>', h.indexOf('class="char-id"'));
  const ctl = `<div class="btn-row char-actions">${picControls(p.id, !!p.portraitUrl)}</div>`;
  return at < 0 ? h : h.slice(0, at) + ctl + h.slice(at);
};

/* =====================================================================
   F1 SIM — the championship hub.
   The front of the Championship page: a card per championship (the
   league's series, and every championship in canon career records) with
   its prizes, who's leading, who last won each, and the character's
   chance of each, worked out from the standings and the races left.
   Each card opens that championship's own leaderboards.
   ===================================================================== */
'use strict';

const CHANCE = { won: ['Won', 'won'], contention: ['In contention', 'contention'], reach: ['In reach', 'reach'], long: ['Long shot', 'long'], out: ['Out of reach', 'out'], role: ['Not for your role', 'na'], na: ['Not racing here', 'na'], record: ['On the record', 'reach'] };
const chip = (k, why) => `<span class="chance ${CHANCE[k][1]}">${CHANCE[k][0]}</span>${why ? ` <span class="muted small">${esc(why)}</span>` : ''}`;
const leagueSeriesIds = () => allSeries().filter(x => list('f1_teams').some(t => (t.seriesId || 'f1') === x.id)).map(x => x.id);
function lastDone(sid) { return seriesSeasons(sid).filter(s => seasonDone(s.id))[0] || null; }
function myRole(c) { return !c ? null : c.role === 'driver' ? 'driver' : c.role === 'principal' ? 'principal' : c.role === 'engineer' ? 'engineer' : 'other'; }

/* ---------------------------------------------------------------- a league championship's prizes */
function leagueCard(sid, c) {
  const s = seriesDoc(sid), sea = curSeasonId(sid), st = standingsFor(sid, sea), rules = seriesRules(s), win = (rules.points || [25])[0] || 25;
  const ws = teamSeasonWeekends(sid, sea).sort((a, b) => String(a.finishedAt).localeCompare(String(b.finishedAt))), gps = ws.filter(w => w.session === 'gp');
  const total = roundsOf(sid), left = Math.max(0, total - gps.length), maxLeft = left * win, last = lastDone(sid), lastSt = last ? standingsFor(sid, last.id) : null;
  const seat = c ? list('f1_seats').find(x => x.holderCharId === c.id && ((get('f1_teams', x.teamId) || {}).seriesId || 'f1') === sid) : null;
  const role = myRole(c), pid = c ? f1PcId(c.id) : null, teamId = seat ? seat.teamId : null, car = seat ? seat.car : null;
  /* What counts as "mine": the driver's own results, the principal's team, or the engineer's car. */
  const mineR = r => role === 'driver' ? r.personId === pid : role === 'principal' ? r.teamId === teamId : role === 'engineer' ? r.teamId === teamId && String(r.car || 1) === String(car || 1) : false;
  const myRes = gps.flatMap(w => (w.results || []).filter(mineR)), best = Math.min(99, ...myRes.map(r => r.position || 99));
  const count = f => myRes.filter(f).length, poles = gps.filter(w => w.quali && w.quali.grid && (w.results || []).some(r => r.id === w.quali.grid[0] && mineR(r))).length;
  const fls = gps.filter(w => w.state && w.state.fastest && (w.results || []).some(r => r.id === w.state.fastest.id && mineR(r))).length;
  const name = id => (F1.person(id) || {}).name || id, tname = id => (get('f1_teams', id) || {}).name || id;
  const by = (f) => { const m = new Map(); gps.forEach(w => (w.results || []).forEach(r => { if (f(r, w)) m.set(r.personId, (m.get(r.personId) || 0) + 1); })); return [...m.entries()].sort((a, b) => b[1] - a[1]); };
  const lastGp = gps[gps.length - 1], lastWin = lastGp && (lastGp.results || []).find(r => r.position === 1), lastPole = lastGp && lastGp.quali && lastGp.quali.grid && (lastGp.results || []).find(r => r.id === lastGp.quali.grid[0]);
  const trackName = w => (F1.track(w.trackId) || {}).name || '';
  const notHere = !seat, nonRacing = role === 'other' || !c;
  const titleChance = (rows, key, mineId, perRace) => {
    if (!c) return '';
    if (nonRacing) return chip('role'); if (notHere) return chip('na');
    const i = rows.findIndex(x => x[key] === mineId), me = rows[i]; if (!gps.length) return chip('reach', 'The season hasn’t started: everyone starts level');
    if (!me) return chip(perRace * left > (rows[0] || { pts: 0 }).pts ? 'long' : 'out', 'No points yet');
    const gap = rows[0].pts - me.pts, room = perRace * left;
    if (i === 0) return chip('contention', `Leading by ${rows[1] ? rows[0].pts - rows[1].pts : rows[0].pts} points`);
    if (gap > room) return chip('out', `${gap} points behind; ${room} left to win`);
    if (gap <= perRace) return chip('contention', `P${i + 1}, ${gap} behind`);
    if (gap <= room * 0.35) return chip('reach', `P${i + 1}, ${gap} behind`);
    return chip('long', `P${i + 1}, ${gap} behind`);
  };
  const raceChance = (got, near, what, none) => { if (!c) return ''; if (nonRacing) return chip('role'); if (notHere) return chip('na');
    if (got) return chip('won', `${got} this season${role === 'principal' ? ' (the team)' : role === 'engineer' ? ' (your car)' : ''}`);
    const why = none || (best < 99 ? `Best finish so far: P${best}` : what); return near ? chip('reach', why) : chip('long', why); };
  const drv = st.drivers, tms = st.teams, winners = by(r => r.position === 1), podders = by(r => r.position && r.position <= 3);
  const prizes = [
    ['Drivers’ title', drv[0] ? `${drv[0].name}, ${drv[0].pts} pts` : 'Not started', lastSt && lastSt.drivers[0] ? `${lastSt.drivers[0].name}, ${last.name}` : '–',
      role === 'driver' ? titleChance(drv, 'personId', pid, win) : role === 'engineer' && seat ? chip(drv.findIndex(x => x.teamId === teamId) === 0 ? 'contention' : 'long', 'Shared if your driver wins it') : c ? chip(nonRacing ? 'role' : notHere ? 'na' : 'role', role === 'principal' ? 'The drivers win this one' : '') : ''],
    ['Constructors’ title', tms[0] ? `${tname(tms[0].teamId)}, ${tms[0].pts} pts` : 'Not started', lastSt && lastSt.teams[0] ? `${tname(lastSt.teams[0].teamId)}, ${last.name}` : '–',
      role === 'principal' ? titleChance(tms, 'teamId', teamId, win + Math.round(win * 0.72)) : c && seat ? chip('role', `${tname(teamId)} are ${tms.findIndex(x => x.teamId === teamId) >= 0 ? 'P' + (tms.findIndex(x => x.teamId === teamId) + 1) : 'not on the board yet'}: your results count`) : c ? chip(nonRacing ? 'role' : 'na') : ''],
    ['Grand Prix win', winners.length ? `${plural(winners.length, 'different winner')}; most: ${name(winners[0][0])} (${winners[0][1]})` : 'No races yet', lastWin ? `${lastWin.name}, ${trackName(lastGp)}` : '–', raceChance(count(r => r.position === 1), best <= 3, 'No results yet')],
    ['Pole position', (() => { const m = new Map(); gps.forEach(w => { const r = w.quali && w.quali.grid && (w.results || []).find(x => x.id === w.quali.grid[0]); if (r) m.set(r.name, (m.get(r.name) || 0) + 1); }); const top = [...m.entries()].sort((a, b) => b[1] - a[1])[0]; return top ? `${top[0]} (${top[1]})` : 'No qualifying yet'; })(), lastPole ? `${lastPole.name}, ${trackName(lastGp)}` : '–', raceChance(poles, best <= 5, 'No results yet', 'No poles yet')],
    ['Podium', podders.length ? `${plural(podders.length, 'driver')} have one; most: ${name(podders[0][0])} (${podders[0][1]})` : 'No races yet', lastGp ? (lastGp.results || []).filter(r => r.position && r.position <= 3).sort((a, b) => a.position - b.position).map(r => r.name.split(' ').pop()).join(', ') : '–', raceChance(count(r => r.position && r.position <= 3), best <= 6, 'No results yet')],
    ['Points finish', `${plural(drv.filter(d => d.pts > 0).length, 'driver')} have scored`, '–', raceChance(count(r => (r.points || 0) > 0), best <= 13, 'No results yet')],
    ['Fastest lap', (() => { const m = new Map(); gps.forEach(w => { const f = w.state && w.state.fastest, r = f && (w.results || []).find(x => x.id === f.id); if (r) m.set(r.name, (m.get(r.name) || 0) + 1); }); const top = [...m.entries()].sort((a, b) => b[1] - a[1])[0]; return top ? `${top[0]} (${top[1]})` : 'No races yet'; })(), (() => { const f = lastGp && lastGp.state && lastGp.state.fastest, r = f && (lastGp.results || []).find(x => x.id === f.id); return r ? `${r.name}, ${trackName(lastGp)}` : '–'; })(), raceChance(fls, best <= 10, 'No results yet', 'No fastest laps yet')]];
  /* Titles in the same championship from career records (before F1 SIM). */
  const canon = canonChamps().find(o => o.name === s.name);
  if (canon) { const ts = canon.rows.filter(y => String(y.r.pos) === '1').sort((a, b) => String(b.r.years).localeCompare(String(a.r.years))), mineT = c ? ts.filter(y => y.c.id === c.id) : [];
    prizes.push(['Title before F1 SIM', `${plural(ts.length, 'title')} on career records`, ts[0] ? `${ts[0].c.name}, ${ts[0].r.years}` : '–', !c ? '' : mineT.length ? chip('won', `Champion ${mineT.map(y => y.r.years).join(', ')} (career record)`) : chip('na', 'Not on the record')]); }
  const status = gps.length ? `${seasonDoc(sea).name} season · ${gps.length} of ${total} rounds run · ${plural(left, 'Grand Prix', 'Grands Prix')} left` : `${seasonDoc(sea).name} season · not started · ${total} rounds`;
  const me = !c ? '' : seat ? `${c.name} races here: ${seatTitle(seat).toLowerCase()}, ${tname(teamId)}` : '';
  const foot = gps.length ? `About ${maxLeft} points are still to be won by one driver (${left} × ${win} for a win).` : 'Nobody has scored yet: every prize is open.';
  return { kind: 'league', key: sid, name: s.name, col: (s.color || '#E10600'), status, me, mine: !!seat || !!(canon && c && canon.rows.some(y => y.c.id === c.id)), seated: !!seat, prizes, foot };
}

/* ---------------------------------------------------------------- championships from career records */
function canonChamps() {
  const m = new Map();
  list('characters').filter(c => !c.retired && charApproved(c)).forEach(c => careerRows(c).filter(r => r.status === 'canon' && (r.role || 'driver') === 'driver').forEach(r => {
    const k = seriesLabel(r), o = m.get(k) || { name: k, rows: [] }; o.rows.push({ c, r }); m.set(k, o); }));
  return [...m.values()].sort((a, b) => b.rows.filter(x => String(x.r.pos) === '1').length - a.rows.filter(x => String(x.r.pos) === '1').length || a.name.localeCompare(b.name));
}
function canonCard(o, c) {
  const titles = o.rows.filter(x => String(x.r.pos) === '1').sort((a, b) => String(b.r.years).localeCompare(String(a.r.years)));
  const lb = canonBoard(o), mine = c ? o.rows.filter(x => x.c.id === c.id) : [], myTitles = mine.filter(x => String(x.r.pos) === '1');
  const chance = !c ? '' : myTitles.length ? chip('won', `Champion ${myTitles.map(x => x.r.years).join(', ')}`) : mine.length ? chip('record', `${plural(mine.length, 'season')} on the record`) : chip('na', 'Not on the record');
  return { kind: 'canon', key: o.name, name: o.name, col: '#565A63', status: `${plural(lb.length, 'character')} with seasons here`, me: '', mine: mine.length > 0,
    prizes: [['Title', lb[0] && lb[0].titles ? `Most: ${lb[0].name} (${lb[0].titles})` : '–', titles[0] ? `${titles[0].c.name}, ${titles[0].r.years}` : 'No titles on record yet', chance],
      ['Wins', lb.slice().sort((a, b) => b.wins - a.wins)[0] && lb.slice().sort((a, b) => b.wins - a.wins)[0].wins ? `Most: ${lb.slice().sort((a, b) => b.wins - a.wins)[0].name}` : '–', '–', !c ? '' : mine.some(x => Number(x.r.wins) > 0) ? chip('won', `${mine.reduce((s, x) => s + (Number(x.r.wins) || 0), 0)} on the record`) : chip('na')]],
    foot: 'Not raced in the league: titles here come from canon career seasons.' };
}
function canonBoard(o) {
  const m = new Map(); o.rows.forEach(({ c, r }) => { const x = m.get(c.id) || { pid: f1PcId(c.id), c, name: c.name, seasons: 0, titles: 0, wins: 0, podiums: 0, best: 99, years: [], roles: new Set() };
    x.seasons++; if (String(r.pos) === '1') { x.titles++; x.years.push(r.years); } x.wins += Number(r.wins) || 0; x.podiums += Number(r.podiums) || 0; x.best = Math.min(x.best, Number(r.pos) || 99); x.roles.add(careerRoleName(r.role)); m.set(c.id, x); });
  return [...m.values()].sort((a, b) => b.titles - a.titles || b.wins - a.wins || b.podiums - a.podiums || a.best - b.best);
}

/* ---------------------------------------------------------------- the hub */
ACTIONS['hub-tab'] = d => { S.ui.hubTab = d.t; render(); };
ACTIONS['champ-open'] = d => { S.ui.champ = { kind: d.kind, key: d.key }; S.ui.champTab = null; go('champ'); };
function cardHtml(x, showChance) {
  return `<section class="champ-card" style="--cc:${esc(x.col)}"><div class="champ-head"><div><h2>${esc(x.name)}</h2><span class="tag ${x.kind === 'league' ? 'league' : ''}">${x.kind === 'league' ? 'Raced in F1 SIM' : 'Career records'}</span>${x.seated && showChance ? ' <span class="tag player">You’re here</span>' : x.mine && showChance ? ' <span class="tag trophy">On your record</span>' : ''}</div>
      <div class="champ-meta"><span class="muted">${esc(x.status)}</span><button class="btn small" data-act="champ-open" data-kind="${x.kind}" data-key="${esc(x.key)}">Leaderboards ›</button></div></div>
    ${x.me && showChance ? `<p class="small champ-me">${esc(x.me)}</p>` : ''}
    <div class="scroll-x"><table class="data champ-prizes"><thead><tr><th>Prize</th><th>Leading now</th><th>Last won by</th>${showChance ? '<th>Your chance</th>' : ''}</tr></thead><tbody>
      ${x.prizes.map(p => `<tr><td><b>${esc(p[0])}</b></td><td>${esc(p[1])}</td><td class="muted">${esc(p[2])}</td>${showChance ? `<td>${p[3] || ''}</td>` : ''}</tr>`).join('')}</tbody></table></div>
    <p class="muted small champ-foot">${esc(x.foot)}</p></section>`;
}
function hubHtml() {
  const c = currentChar(), tab = S.ui.hubTab || (c ? 'me' : 'all');
  const league = leagueSeriesIds().map(sid => leagueCard(sid, c)), lnames = new Set(league.map(x => x.name)), canon = canonChamps().filter(o => !lnames.has(o.name)).map(o => canonCard(o, c));
  const tabs = `<div class="hub-bar"><span class="muted small">Show</span><div class="seg hub-tabs" role="tablist" aria-label="Show">${(c ? [['me', `For ${c.name.split(' ')[0]}`]] : []).concat([['all', 'Every championship'], ['records', 'Records']]).map(([k, l]) => `<button role="tab" aria-selected="${tab === k}" data-act="hub-tab" data-t="${k}">${esc(l)}</button>`).join('')}</div></div>`;
  const key = `<div class="chance-key">${['won', 'contention', 'reach', 'long', 'out', 'na'].map(k => chip(k)).join(' ')}</div>`;
  let body;
  if (tab === 'records') {
    const recs = leagueSeriesIds().map(sid => { const a = allTimeData(sid), s = seriesDoc(sid), byWins = a.drivers.slice().sort((x, y) => y.wins - x.wins)[0], byT = a.drivers[0];
      return [s.name, byT && byT.titles.length ? `${byT.name} (${byT.titles.length})` : '–', byWins && byWins.wins ? `${byWins.name} (${byWins.wins})` : '–', a.teams[0] && a.teams[0].titles.length ? `${(get('f1_teams', a.teams[0].teamId) || {}).name} (${a.teams[0].titles.length})` : '–', 'league', sid]; })
      .concat(canonChamps().filter(o => !leagueSeriesIds().some(sid => seriesDoc(sid).name === o.name)).map(o => { const b = canonBoard(o), w = b.slice().sort((x, y) => y.wins - x.wins)[0]; return [o.name, b[0] && b[0].titles ? `${b[0].name} (${b[0].titles})` : '–', w && w.wins ? `${w.name} (${w.wins})` : '–', '–', 'canon', o.name]; }));
    body = `<section class="card"><h2>Records in every championship</h2><div class="scroll-x"><table class="data"><thead><tr><th>Championship</th><th>Most titles</th><th>Most wins</th><th>Most constructors’ titles</th><th></th></tr></thead><tbody>${recs.map(r => `<tr><td><b>${esc(r[0])}</b></td><td>${esc(r[1])}</td><td>${esc(r[2])}</td><td>${esc(r[3])}</td><td><button class="btn small" data-act="champ-open" data-kind="${r[4]}" data-key="${esc(r[5])}">Leaderboards ›</button></td></tr>`).join('')}</tbody></table></div></section>`;
  } else {
    const cards = tab === 'me' ? league.filter(x => x.mine).concat(canon.filter(x => x.mine)).concat(league.filter(x => !x.mine)) : league.concat(canon);
    body = (tab === 'me' && c ? `<p class="muted">${esc(c.name)}: ${esc(charRoleName(c.role).toLowerCase())}. ${myRole(c) === 'principal' ? 'Chances are the team’s.' : myRole(c) === 'engineer' ? 'Chances are your car’s.' : myRole(c) === 'other' ? 'Racing prizes aren’t open to this role.' : ''}</p>${key}` : tab === 'all' && c ? key : '')
      + cards.map(x => cardHtml(x, !!c)).join('') || '<p class="muted">No championships yet.</p>';
  }
  return `<div class="page-head"><div><h1>Championship</h1><p>Every prize in every championship, who’s leading, and ${c ? `${esc(c.name.split(' ')[0])}’s chance of each` : 'who won them last'}. Open a championship for its leaderboards.</p></div></div>`
    + `<div class="seg stand-tabs" role="tablist" aria-label="Standings"><button role="tab" aria-selected="true" data-act="stand-view" data-v="hub">What’s up for grabs</button><button role="tab" aria-selected="false" data-act="stand-view" data-v="season">This season</button><button role="tab" aria-selected="false" data-act="stand-view" data-v="alltime">All-time in F1 SIM</button><button role="tab" aria-selected="false" data-act="stand-view" data-v="career">Career: every championship</button></div>`
    + tabs + body;
}
const _standingsViewHub = ROUTES.standings.view;
ROUTES.standings.view = function () {
  if (!S.ui.standView) S.ui.standView = 'hub';
  if (S.ui.standView === 'hub') return hubHtml();
  return _standingsViewHub().replace('<div class="seg stand-tabs" role="tablist" aria-label="Standings">', '<div class="seg stand-tabs" role="tablist" aria-label="Standings"><button role="tab" aria-selected="false" data-act="stand-view" data-v="hub">What’s up for grabs</button>');
};

/* ---------------------------------------------------------------- one championship's leaderboards */
ACTIONS['champ-tab'] = d => { S.ui.champTab = d.t; render(); };
const lbTable = (head, rows) => `<div class="scroll-x"><table class="data"><thead><tr>${head.map(h => `<th${/^(Pts|Points|Wins|Podiums|Poles|Seasons|Starts|Races|Titles)$/.test(h) ? ' class="num"' : ''}>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.join('') || `<tr><td colspan="${head.length}" class="muted">Nobody yet.</td></tr>`}</tbody></table></div>`;
const tagP = c => c ? ' <span class="tag player">Player</span>' : '';
route('champ', 'Championship', function () {
  const x = S.ui.champ; if (!x) { go('standings'); return ''; }
  const back = '<button class="btn ghost small" data-act="nav" data-route="standings">‹ All championships</button>';
  if (x.kind === 'canon') {
    const o = canonChamps().find(y => y.name === x.key) || { name: x.key, rows: [] }, b = canonBoard(o);
    const titles = o.rows.filter(y => String(y.r.pos) === '1').sort((a, z) => String(z.r.years).localeCompare(String(a.r.years)));
    return `${back}<div class="page-head"><div><p class="eyebrow">Career records</p><h1>${esc(o.name)}</h1><p>Not raced in the league. Seasons and titles come from characters’ canon career records.</p></div></div>
      <section class="card"><h2>Leaderboard</h2>${lbTable(['Pos', 'Character', 'Titles', 'Wins', 'Podiums', 'Seasons', 'Best', 'Role'], b.map((r, i) => `<tr><td><b>${i + 1}</b></td><td>${careerLink(r.pid, r.name)}</td><td class="num">${r.titles ? `<span class="tag trophy">${r.titles}</span>` : 0}</td><td class="num">${r.wins}</td><td class="num">${r.podiums}</td><td class="num">${r.seasons}</td><td>${r.best === 1 ? 'Champion' : r.best < 99 ? ordinal(r.best) : '–'}</td><td class="muted">${esc([...r.roles].join(', '))}</td></tr>`))}</section>
      <section class="card"><h2>Champions by year</h2>${titles.length ? `<ul class="champ-years">${titles.map(y => `<li><b>${esc(y.r.years)}</b> ${careerLink(f1PcId(y.c.id), y.c.name)}${y.r.team ? ` <span class="muted">· ${esc(y.r.team)}</span>` : ''}${(y.r.role || 'driver') !== 'driver' ? ` <span class="muted">(${esc(careerRoleName(y.r.role).toLowerCase())})</span>` : ''}</li>`).join('')}</ul>` : '<p class="muted">No titles on record yet.</p>'}</section>`;
  }
  const sid = x.key, s = seriesDoc(sid), sea = curSeasonId(sid), tab = S.ui.champTab || 'season', tname = id => (get('f1_teams', id) || {}).name || id;
  const tabs = `<div class="seg" role="tablist" aria-label="Leaderboards">${[['season', `${seasonDoc(sea).name} season`], ['alltime', 'All-time'], ['champions', 'Champions']].map(([k, l]) => `<button role="tab" aria-selected="${tab === k}" data-act="champ-tab" data-t="${k}">${esc(l)}</button>`).join('')}</div>`;
  let body = '';
  if (tab === 'season') {
    const st = standingsFor(sid, sea);
    body = `<div class="cols2" style="align-items:start"><section class="card"><h2>Drivers</h2>${lbTable(['Pos', 'Driver', 'Team', 'Wins', 'Podiums', 'Pts'], st.drivers.map((d, i) => `<tr${S.charId && d.charId === S.charId ? ' class="me"' : ''}><td><b>${i + 1}</b></td><td>${careerLink(d.personId, d.name)}${tagP(d.charId)}</td><td><span class="f1-bar" style="background:${esc(f1Colour(d.teamId))}"></span>${esc(tname(d.teamId))}</td><td class="num">${d.wins}</td><td class="num">${d.podiums}</td><td class="num"><b>${d.pts}</b></td></tr>`))}</section>
      <section class="card"><h2>Constructors</h2>${lbTable(['Pos', 'Team', 'Wins', 'Podiums', 'Pts'], st.teams.map((t, i) => `<tr><td><b>${i + 1}</b></td><td><button class="link-btn" data-act="team-open" data-id="${esc(t.teamId)}"><span class="f1-bar" style="background:${esc(f1Colour(t.teamId))}"></span>${esc(tname(t.teamId))}</button></td><td class="num">${t.wins}</td><td class="num">${t.podiums}</td><td class="num"><b>${t.pts}</b></td></tr>`))}</section></div>`;
  } else if (tab === 'alltime') {
    const a = allTimeData(sid), tp = staffStats(sid, 'principal'), eng = staffStats(sid, 'engineer');
    const staffRows = rows => rows.map((o, i) => `<tr><td><b>${i + 1}</b></td><td>${careerLink(o.pid, o.name)}${tagP(o.charId)}</td><td class="num">${o.races}</td><td class="num">${o.wins}</td><td class="num">${o.podiums}</td><td>${o.titles.map(t => `<span class="tag trophy">${esc(t)}</span>`).join(' ')}</td></tr>`);
    body = `<div class="cols2" style="align-items:start"><section class="card"><h2>Drivers</h2>${lbTable(['Pos', 'Driver', 'Seasons', 'Wins', 'Podiums', 'Points', 'Titles'], a.drivers.map((d, i) => `<tr><td><b>${i + 1}</b></td><td>${careerLink(d.personId, d.name)}${tagP(d.charId)}</td><td class="num">${d.seasons}</td><td class="num">${d.wins}</td><td class="num">${d.podiums}</td><td class="num"><b>${d.pts}</b></td><td>${d.titles.map(t => `<span class="tag trophy">${esc(t)}</span>`).join(' ')}</td></tr>`))}</section>
      <section class="card"><h2>Constructors</h2>${lbTable(['Pos', 'Team', 'Seasons', 'Wins', 'Points', 'Titles'], a.teams.map((t, i) => `<tr><td><b>${i + 1}</b></td><td>${esc(tname(t.teamId))}</td><td class="num">${t.seasons}</td><td class="num">${t.wins}</td><td class="num"><b>${t.pts}</b></td><td>${t.titles.map(z => `<span class="tag trophy">${esc(z)}</span>`).join(' ')}</td></tr>`))}</section></div>
      <div class="cols2" style="align-items:start"><section class="card"><h2>Team principals</h2><p class="muted small">Their team’s results while in charge.</p>${lbTable(['Pos', 'Principal', 'Races', 'Wins', 'Podiums', 'Titles'], staffRows(tp))}</section>
      <section class="card"><h2>Race engineers</h2><p class="muted small">Their car’s results.</p>${lbTable(['Pos', 'Engineer', 'Races', 'Wins', 'Podiums', 'Titles'], staffRows(eng))}</section></div>`;
  } else {
    const seasons = seriesSeasons(sid).filter(z => seasonDone(z.id)), canon = canonChamps().find(o => o.name === s.name);
    const ct = canon ? canon.rows.filter(y => String(y.r.pos) === '1').sort((a, z) => String(z.r.years).localeCompare(String(a.r.years))) : [];
    body = `<section class="card"><h2>F1 SIM champions</h2>${seasons.length ? lbTable(['Season', 'Drivers’ champion', 'Constructors’ champions'], seasons.map(z => { const st = standingsFor(sid, z.id); return `<tr><td><b>${esc(z.name)}</b>${z.imported ? ' <span class="muted small">imported</span>' : ''}</td><td>${st.drivers[0] ? careerLink(st.drivers[0].personId, st.drivers[0].name) + tagP(st.drivers[0].charId) : '–'}</td><td>${st.teams[0] ? esc(tname(st.teams[0].teamId)) : '–'}</td></tr>`; })) : '<p class="muted">No season catalogued yet. The current season’s champions appear here once it’s catalogued.</p>'}</section>
      ${ct.length ? `<section class="card"><h2>${esc(s.name)} champions before F1 SIM</h2><p class="muted small">From characters’ canon career records.</p><ul class="champ-years">${ct.map(y => `<li><b>${esc(y.r.years)}</b> ${careerLink(f1PcId(y.c.id), y.c.name)}${y.r.team ? ` <span class="muted">· ${esc(y.r.team)}</span>` : ''}</li>`).join('')}</ul></section>` : ''}`;
  }
  return `${back}<div class="page-head"><div><p class="eyebrow">Raced in F1 SIM</p><h1>${esc(s.name)}</h1><p>${esc(leagueCard(sid, null).status)}</p></div></div>${tabs}${body}`;
});
if (LIMITED_ROUTES.indexOf('champ') === -1) LIMITED_ROUTES.push('champ');

/* =====================================================================
   F1 SIM — the Grid page.
   Players start on "Find a seat": seats for their character's role,
   open ones first (Apply), then ones that could open (Interested), then
   ones players hold. "Whole grid" shows every team as a row and every
   seat as a chip: Player, Open seat (taking applications), Real person,
   or Vacant post. Race Control clicks a seat to fill it, hand it back
   or open it, and sees who has applied or is interested. The grid can
   be posted to Discord as one message that keeps itself up to date.
   ===================================================================== */
'use strict';

if (!DISCORD_PURPOSES.some(p => p[0] === 'grid')) DISCORD_PURPOSES.push(['grid', 'The grid (one post, kept up to date)', 'DISCORD_WEBHOOK_GRID']);
const SEAT_ROLE_OF = { driver: 'driver', principal: 'principal', engineer: 'engineer' };
const seatState = s => s.holderCharId ? 'P' : s.open ? 'O' : s.defaultPersonId ? 'R' : 'V';
const STATE_NAME = { P: 'Player', O: 'Open seat', R: 'Real', V: 'Vacant post' };
const seatApps = s => list('f1_applications').filter(a => a.seatId === s.id && a.status === 'pending');
const seatInterest = s => list('f1_applications').filter(a => a.seatId === s.id && a.status === 'interest');
function gridCols(teams) {
  const seats = teams.flatMap(t => F1.seats(t.id)), cars = r => [...new Set(seats.filter(s => s.role === r).map(s => s.car || 1))].sort((a, b) => a - b);
  return cars('driver').map(c => ['driver', c, `Car ${c}`]).concat([['principal', null, 'Team principal']]).concat(cars('engineer').map(c => ['engineer', c, `Car ${c}`]));
}
const seatFor = (tid, role, car) => F1.seats(tid).find(s => s.role === role && (role === 'principal' || (s.car || 1) === car));

/* ---------------------------------------------------------------- a seat chip */
function chipHtml(s) {
  const st = seatState(s), o = f1Occupant(s), pid = o.person ? o.person.id : null, c = o.charId ? get('characters', o.charId) : null, pic = personPic(pid, c);
  const me = currentChar(), apps = seatApps(s), ints = seatInterest(s), mineApp = me && apps.find(a => a.charId === me.id);
  const name = st === 'V' ? 'Vacant post' : !o.person && !o.charId ? 'Open post' : o.name;
  const sub = st === 'P' ? `Player${c && c.number && s.role === 'driver' ? ' · #' + c.number : ''}${S.charId && s.holderCharId === S.charId ? ' · You' : ''}`
    : st === 'O' ? `Open${apps.length ? ` · ${apps.length} applied` : ''}${S.isGm && ints.length ? ` · ${ints.length} interested` : ''}`
    : st === 'R' ? `Real ${s.role === 'driver' ? 'driver' : s.role === 'principal' ? 'principal' : 'engineer'}${S.isGm && ints.length ? ` · ${ints.length} interested` : ''}` : (S.isGm && ints.length ? `${ints.length} interested` : '');
  const face = `<span class="gc-face">${pic ? `<img src="${esc(pic)}" alt="">` : esc(st === 'V' || (!o.person && !o.charId) ? '+' : initials(name))}</span>`;
  const body = `${face}<span class="gc-txt"><em class="gc-role">${esc(s.role === 'driver' ? `Driver ${s.car || 1}` : s.role === 'principal' ? 'Team principal' : `Engineer ${s.car || 1}`)}</em><b>${esc(name)}</b><small>${esc(sub)}</small></span>`;
  const label = `${seatTitle(s)}, ${F1.team(s.teamId).name}: ${name}, ${STATE_NAME[st].toLowerCase()}`;
  if (S.isGm) return `<button class="gc gc-${st}" data-act="seat-edit" data-id="${esc(s.id)}" aria-label="${esc(label)}. Change">${body}</button>`;
  const roleOk = me && SEAT_ROLE_OF[me.role] === s.role && charApproved(me) && !s.holderCharId;
  if (st === 'O' && roleOk) return `<button class="gc gc-O gc-act" data-act="${mineApp ? 'app-withdraw' : 'seat-apply'}" data-id="${esc(mineApp ? mineApp.id : s.id)}" aria-label="${esc(label)}. ${mineApp ? 'Withdraw your application' : 'Apply'}">${body}<span class="gc-cta">${mineApp ? 'Applied ✓' : 'Apply'}</span></button>`;
  if (pid) return `<button class="gc gc-${st}" data-act="career" data-id="${esc(pid)}" aria-label="${esc(label)}">${body}</button>`;
  return `<div class="gc gc-${st}">${body}</div>`;
}

/* ---------------------------------------------------------------- the whole grid */
ACTIONS['grid-role'] = d => { S.ui.gridRole = d.r; render(); };
CHANGES['grid-open'] = (v, d, el) => { S.ui.gridOpen = !!(el && el.checked); render(); };
function wholeGridHtml(teams) {
  const role = S.ui.gridRole || 'all', openOnly = !!S.ui.gridOpen, cols = gridCols(teams).filter(c => role === 'all' || c[0] === role);
  const all = teams.flatMap(t => F1.seats(t.id)), cnt = r => all.filter(s => s.role === r), held = r => cnt(r).filter(s => s.holderCharId).length, open = r => cnt(r).filter(s => s.open).length;
  const pending = all.reduce((n, s) => n + seatApps(s).length, 0);
  const tiles = [[`${held('driver')} of ${cnt('driver').length}`, 'Driver seats held by players', `${open('driver')} open for applications`],
    [`${held('principal')} of ${cnt('principal').length}`, 'Team principals are players', `${open('principal')} open for applications`],
    [`${held('engineer')} of ${cnt('engineer').length}`, 'Race engineers are players', `${open('engineer')} open for applications${cnt('engineer').filter(s => !s.holderCharId && !s.defaultPersonId && !s.open).length ? `, ${cnt('engineer').filter(s => !s.holderCharId && !s.defaultPersonId && !s.open).length} vacant` : ''}`],
    [String(pending), 'Applications waiting', S.isGm ? 'Click a seat to decide' : 'Race Control decides']];
  const rows = teams.map(t => { const st = standingsFor(t.seriesId || 'f1', curSeasonId(t.seriesId || 'f1')), i = st.teams.findIndex(x => x.teamId === t.id);
    const cells = cols.map(([r, car], ci) => { const cls = `g-${r}${ci === 0 || cols[ci - 1][0] !== r ? ' g-first' : ''}`, s = seatFor(t.id, r, car); if (!s) return `<td class="${cls}"></td>`; if (openOnly && !s.open) return `<td class="${cls}"><span class="gc-dim">–</span></td>`; return `<td class="${cls}">${chipHtml(s)}</td>`; }).join('');
    if (openOnly && !cols.some(([r, car]) => (seatFor(t.id, r, car) || {}).open)) return '';
    return `<tr><th scope="row" class="gt-team" style="--team:${esc(f1Colour(t.id))}"><button class="link-btn" data-act="team-open" data-id="${esc(t.id)}"><b>${esc(t.name)}</b></button><small>${esc(engineLabel(t.id))}${i >= 0 ? ` · P${i + 1}` : ''}</small>${S.isGm ? `<button class="btn small ghost gt-car" data-act="car-edit" data-id="${esc(t.id)}">Car</button>` : ''}</th>${cells}</tr>`; }).join('');
  return `<div class="grid-tools"><div class="seg" role="tablist" aria-label="Seats">${[['all', 'All seats'], ['driver', 'Drivers'], ['principal', 'Team principals'], ['engineer', 'Race engineers']].map(([k, l]) => `<button role="tab" aria-selected="${role === k}" data-act="grid-role" data-r="${k}">${esc(l)}</button>`).join('')}</div>
      <label class="grid-openonly"><input type="checkbox" data-change="grid-open" ${openOnly ? 'checked' : ''}> Open seats only</label></div>
    <div class="metrics grid-tiles">${tiles.map(([v, k, s]) => `<div class="metric"><b>${esc(v)}</b><span>${esc(k)}</span><small class="muted">${esc(s)}</small></div>`).join('')}</div>
    <div class="grid-key">${['P', 'O', 'R', 'V'].map(k => `<span><i class="gk gk-${k}"></i>${esc({ P: 'Player', O: 'Open seat: taking applications', R: 'Real person (not open)', V: 'Vacant post' }[k])}</span>`).join('')}</div>
    <div class="scroll-x grid-table-wrap"><table class="grid-table"><thead><tr class="g-groups"><th rowspan="2">Team</th>${[['driver', 'Drivers'], ['principal', 'Team principal'], ['engineer', 'Race engineers']].map(([r, l]) => { const n = cols.filter(c => c[0] === r).length; return n ? `<th colspan="${n}" class="g-${r} g-first">${esc(l)}</th>` : ''; }).join('')}</tr><tr>${cols.map((c, ci) => `<th class="g-${c[0]}${ci === 0 || cols[ci - 1][0] !== c[0] ? ' g-first' : ''}">${esc(c[0] === 'principal' ? '' : c[2])}</th>`).join('')}</tr></thead><tbody>${rows || `<tr><td colspan="${cols.length + 1}" class="muted">No open seats right now.</td></tr>`}</tbody></table></div>
    <p class="muted small">${S.isGm ? 'Click any seat to put a character in it, hand it back to the real person, or open it for applications.' : 'Open seats taking applications for your role have an Apply button. Click anyone to see their page.'}</p>`;
}

/* ---------------------------------------------------------------- finding a seat */
ACTIONS['grid-tab'] = d => { S.ui.gridTab = d.t; render(); };
ACTIONS['seat-interest'] = d => { const c = currentChar(), s = get('f1_seats', d.id); if (!c || !s) return;
  const mine = list('f1_applications').find(a => a.charId === c.id && a.seatId === s.id && a.status === 'interest');
  run(async () => { if (mine) await Data.remove('f1_applications', mine.id);
    else await Data.put('f1_applications', newId('int'), { userId: asOwner(), charId: c.id, charName: c.name, seatId: s.id, teamId: s.teamId, role: s.role, status: 'interest', kind: 'interest', createdAt: nowIso() }); },
    mine ? 'No longer marked as interested.' : 'Race Control can see you’re interested in this seat.'); };
function finderHtml(c, teams) {
  const role = SEAT_ROLE_OF[c.role];
  if (!role) return `<div class="card notice"><p>${esc(c.name)} is a ${esc(charRoleName(c.role).toLowerCase())}: that role doesn’t take a seat. Their story happens around the paddock.</p></div>`;
  if (!charApproved(c)) return `<div class="card notice"><p>Once Race Control approves ${esc(c.name)}, you can apply for open seats here.</p></div>`;
  const sid = curSeriesId(), st = standingsFor(sid, curSeasonId(sid)), seats = teams.flatMap(t => F1.seats(t.id)).filter(s => s.role === role);
  const pos = tid => { const i = st.teams.findIndex(x => x.teamId === tid); return i >= 0 ? { p: `P${i + 1}`, pts: st.teams[i].pts } : { p: '–', pts: 0 }; };
  const open = seats.filter(s => s.open && !s.holderCharId), could = seats.filter(s => !s.open && !s.holderCharId), held = seats.filter(s => s.holderCharId);
  const roleWord = role === 'driver' ? 'driver seats' : role === 'principal' ? 'team principal seats' : 'race engineer posts';
  const lineup = t => F1.seats(t.id).filter(x => x.role === 'driver').map(x => `${f1Occupant(x).name}${x.holderCharId ? ' (player)' : ''}`).join(' and ');
  const openCard = s => { const t = F1.team(s.teamId), o = f1Occupant(s), ps = pos(t.id), app = list('f1_applications').find(a => a.charId === c.id && a.seatId === s.id && a.status === 'pending');
    return `<article class="seat-open" style="--team:${esc(f1Colour(t.id))}"><div class="so-head"><div><h3>${esc(t.name)}</h3><span>${esc(seatTitle(s))}${o.real ? ` · in place of ${esc(o.real.name)}` : ''}</span></div><span class="tag open">${plural(seatApps(s).length, 'application')}</span></div>
      <div class="so-facts"><div><b>${esc(ps.p)}</b><span>Constructors’</span></div><div><b>${ps.pts}</b><span>Points</span></div><div><b>${esc(engineLabel(t.id))}</b><span>Engine</span></div></div>
      <p class="muted small">${role === 'driver' ? 'Team' : 'Drivers'}: ${esc(lineup(t))}.</p>
      <div class="btn-row">${app ? `<span class="tag player">Applied</span><button class="btn" data-act="app-withdraw" data-id="${esc(app.id)}">Withdraw</button>` : `<button class="btn primary" data-act="seat-apply" data-id="${esc(s.id)}">Apply for this seat</button>`}<button class="btn ghost" data-act="team-open" data-id="${esc(t.id)}">See the team</button></div></article>`; };
  const couldRow = s => { const t = F1.team(s.teamId), o = f1Occupant(s), ps = pos(t.id), mine = list('f1_applications').some(a => a.charId === c.id && a.seatId === s.id && a.status === 'interest');
    return `<div class="seat-could" style="--team:${esc(f1Colour(t.id))}"><span><b>${esc(t.name)}</b>${role !== 'principal' ? ` <span class="muted small">${esc(seatTitle(s).replace(/^.*, /, ''))}</span>` : ''}<br><small class="muted">${esc(o.real ? o.real.name : 'Vacant post')}${ps.p !== '–' ? ` · ${esc(ps.p)}` : ''}</small></span>
      <button class="btn small ${mine ? 'on' : ''}" data-act="seat-interest" data-id="${esc(s.id)}" aria-pressed="${mine}">${mine ? 'Interested ✓' : 'Interested'}</button></div>`; };
  const other = allSeries().filter(x => x.id !== sid).map(x => [x, list('f1_seats').filter(s => s.role === role && s.open && !s.holderCharId && ((get('f1_teams', s.teamId) || {}).seriesId || 'f1') === x.id).length]).filter(x => x[1]);
  return `<section class="finder-sec"><h2>Open now <span class="tag open">taking applications</span></h2>${open.length ? `<div class="seat-open-grid">${open.map(openCard).join('')}</div>` : `<p class="muted">No ${roleWord} are open for applications right now. Mark the ones you’d like below: Race Control sees who’s interested when deciding what to open.</p>`}</section>
    <section class="card"><h2>Could open</h2><p class="muted small">${role === 'engineer' ? 'Posts that aren’t open yet.' : `Held by real ${role === 'driver' ? 'drivers' : 'team principals'}.`} Race Control opens seats when a team wants a player there; mark the ones you’d like.</p>${could.length ? `<div class="seat-could-grid">${could.map(couldRow).join('')}</div>` : '<p class="muted">None.</p>'}</section>
    ${held.length ? `<section class="card"><h2>Held by players</h2><div class="held-list">${held.map(s => `<span class="held-chip" style="--team:${esc(f1Colour(s.teamId))}"><i></i><b>${esc(F1.team(s.teamId).name)}</b> ${esc(f1Occupant(s).name)}</span>`).join('')}</div></section>` : ''}
    ${other.length ? `<p class="muted small">Other series: ${other.map(([x, n]) => `${esc(x.name)} has ${plural(n, 'open ' + (role === 'driver' ? 'driver seat' : role === 'principal' ? 'team principal seat' : 'engineer post'))}`).join('; ')}. Switch series at the top of the page.</p>` : ''}`;
}

/* ---------------------------------------------------------------- the page */
const _gridViewOld = ROUTES.grid.view;
ROUTES.grid.view = function () {
  const teams = F1.teams(); if (!teams.length) return _gridViewOld();
  const c = currentChar(), mine = f1MySeats(), canFind = !!(c && SEAT_ROLE_OF[c.role]);
  const tab = S.ui.gridTab || (!S.isGm && canFind && !mine.length ? 'find' : 'grid');
  const tabs = (canFind || !S.isGm) && c ? `<div class="seg" role="tablist" aria-label="View"><button role="tab" aria-selected="${tab === 'find'}" data-act="grid-tab" data-t="find">Find a seat</button><button role="tab" aria-selected="${tab === 'grid'}" data-act="grid-tab" data-t="grid">Whole grid</button></div>` : '';
  const gd = gridDoc(curSeriesId());
  const rc = S.isGm ? `<div class="grid-rc"><button class="btn" data-act="grid-post">${gd.messageId ? 'Update the grid on Discord' : 'Post the grid to Discord'}</button><label class="small"><input type="checkbox" data-change="grid-auto" ${gd.auto ? 'checked' : ''}> Keep the Discord grid up to date as seats change</label>${gd.at ? `<span class="muted small">Last posted ${esc(fmtWhen(gd.at))}${gd.channel ? ` to #${esc(gd.channel)}` : ''}</span>` : S.discordCh ? `<span class="muted small">Goes to #${esc(gridChannel(curSeriesId(), S.discordCh))}</span>` : ''}
      <button class="btn small" data-act="seats-open-all">Open every seat</button><button class="btn small ghost" data-act="seats-close-all">Close every seat</button>
      <label class="small"><input type="checkbox" data-change="transfer-toggle" ${typeof transfersOn === 'function' && transfersOn() ? 'checked' : ''}> Post a transfer card when I move a character to another team</label></div>` : '';
  const mineHtml = mine.length ? `<div class="card your-seat" style="--team:${esc(f1Colour(mine[0].teamId))}"><b>Your seat:</b> ${mine.map(s => `${esc(seatTitle(s))}, ${esc(F1.team(s.teamId).name)}${f1Occupant(s).real ? `, in place of ${esc(f1Occupant(s).real.name)}` : ''}`).join('; ')}. Your pit wall is on Race Weekend whenever a weekend is open.</div>` : '';
  const head = `<div class="page-head"><div><p class="eyebrow">${esc(curSeries().name)} · ${esc(curSeason().name)} season</p><h1>${tab === 'find' && c ? `Find a seat for ${esc(c.name)}` : 'The Grid'}</h1>
      <p>${tab === 'find' && c ? `${esc(charRoleName(c.role))}${mine.length ? '' : ', without a seat'}. Showing ${esc(c.role === 'driver' ? 'driver seats' : c.role === 'principal' ? 'team principal seats' : 'race engineer posts')}.` : 'Who sits where. Players race or run teams in place of the real people until the seat is handed back.'}</p></div>${tabs}</div>`;
  return head + rc + mineHtml + (tab === 'find' && c ? finderHtml(c, teams) : wholeGridHtml(teams))
    + (S.isGm ? `<p class="muted small" style="margin-top:16px"><button class="btn small ghost" data-act="f1-load">Reload today’s grid</button></p>` : '');
};

/* ---------------------------------------------------------------- Race Control's seat panel */
ACTIONS['seat-edit'] = d => { if (!S.isGm) return; S.ui.seatEdit = d.id; openDrawer('seat'); };
DRAWERS.seat = function () {
  const s = get('f1_seats', S.ui.seatEdit); if (!s) return '';
  const t = F1.team(s.teamId), o = f1Occupant(s), st = seatState(s), apps = seatApps(s), ints = seatInterest(s);
  return `<header><div><h2>${esc(t.name)}: ${esc(seatTitle(s).toLowerCase())}</h2><p>${esc(st === 'V' ? 'No one in the post' : o.name)} · ${esc(STATE_NAME[st])}${o.player && o.real ? `, in place of ${esc(o.real.name)}` : ''}</p></div><button class="btn ghost" data-act="close-drawer">Close</button></header>
    <div class="body"><h3>Who sits here</h3>${f1SeatControls(s)}
    <p class="muted small">Pick a character to put them here, or the first option to hand the seat back. “Open it” lets players apply.</p>
    <h3>Applications ${apps.length ? `<span class="count">${apps.length}</span>` : ''}</h3>${apps.length ? apps.map(a => `<div class="seat-app"><b>${esc(a.charName)}</b> <span class="muted small">${esc(fmtWhen(a.createdAt))}</span>${a.note ? `<p class="small">${esc(a.note)}</p>` : ''}<div class="btn-row"><button class="btn small primary" data-act="app-decide" data-id="${esc(a.id)}" data-ok="1">Give them the seat</button><button class="btn small" data-act="app-decide" data-id="${esc(a.id)}" data-ok="0">Turn down</button></div></div>`).join('') : '<p class="muted small">None.</p>'}
    <h3>Interested ${ints.length ? `<span class="count">${ints.length}</span>` : ''}</h3>${ints.length ? `<p>${ints.map(a => esc(a.charName)).join(', ')}</p><p class="muted small">Open the seat to let them apply.</p>` : '<p class="muted small">Nobody yet.</p>'}</div>`;
};

/* ---------------------------------------------------------------- the grid on Discord, kept up to date */
/* A series' grid goes to its own grid channel, else its teams channel (DISCORD_WEBHOOK_F2_TEAMS or _TEAM), else the general ones. */
function gridChannel(sid, list) { return [`${sid}-grid`, `${sid}-teams`, `${sid}-team`, 'grid', 'teams', 'team', 'default'].find(c => list.indexOf(c) !== -1) || list[0] || 'default'; }
const gridDoc = sid => get('f1_settings', `discord-grid-${sid}`) || {};
CHANGES['grid-auto'] = (v, d, el) => { const sid = curSeriesId(), on = !!(el && el.checked);
  run(async () => { await Data.put('f1_settings', `discord-grid-${sid}`, Object.assign({}, clone(gridDoc(sid)), { auto: on })); }, on ? 'The Discord grid will update itself as seats change.' : 'The Discord grid won’t update itself.'); };
async function drawGridImage(sid) {
  const teams = list('f1_teams').filter(t => (t.seriesId || 'f1') === sid).sort((a, b) => (a.order || 0) - (b.order || 0)), cols = gridCols(teams);
  const W = 1920, top = 220, rowH = Math.min(76, Math.floor((1080 - top - 60) / Math.max(1, teams.length))), H = top + rowH * teams.length + 70;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H; const g = cv.getContext('2d'), T = EXP_THEMES.dark;
  try { await Promise.all(['700 40px "Titillium Web"', '600 20px "Titillium Web"'].map(f => document.fonts.load(f))); } catch (e) { /* fall back */ }
  const logo = await loadImg(leagueLogo());
  g.fillStyle = '#1C1D22'; g.fillRect(0, 0, W, H);
  const me = drawMark(g, 50, 44, Object.assign({}, T, { ink: '#FFFFFF' }), logo); g.fillStyle = '#FFFFFF'; g.font = cond(700, 46); g.fillText(`${seriesDoc(sid).name} grid`, me + 30, 84);
  g.font = bodyF(500, 22); g.fillStyle = T.muted; g.fillText(`${seasonDoc(curSeasonId(sid)).name} season`, me + 30, 118);
  const KEY = { P: ['#3A1D20', '#E10600', 'Player'], O: ['#13261B', '#7CD69C', 'Open seat'], R: ['#2E3037', '#3A3D45', 'Real person'], V: ['#202126', '#4A4E57', 'Vacant post'] };
  let kx = W - 50; g.textAlign = 'right'; ['V', 'R', 'O', 'P'].forEach(k => { g.font = bodyF(600, 20); g.fillStyle = '#C9CCD2'; g.fillText(KEY[k][2], kx, 84); kx -= g.measureText(KEY[k][2]).width + 10; g.fillStyle = KEY[k][0]; g.fillRect(kx - 20, 66, 20, 20); g.strokeStyle = KEY[k][1]; g.lineWidth = 2; g.strokeRect(kx - 19, 67, 18, 18); kx -= 46; }); g.textAlign = 'left';
  const teamW = 250, cw = (W - 100 - teamW) / cols.length;
  const GC = { driver: ['#E10600', 'Drivers'], principal: ['#F5C400', 'Team principal'], engineer: ['#5AA9FF', 'Race engineers'] };
  ['driver', 'principal', 'engineer'].forEach(r => { const idx = cols.map((c, i) => c[0] === r ? i : -1).filter(i => i >= 0); if (!idx.length) return; const x0 = 50 + teamW + idx[0] * cw + 4, w = idx.length * cw - 8;
    g.fillStyle = GC[r][0]; g.fillRect(x0, top - 64, w, 4); g.font = bodyF(700, 20); g.fillText(GC[r][1], x0, top - 72); if (idx[0] > 0) { g.fillStyle = '#565A63'; g.fillRect(x0 - 6, top - 60, 2, rowH * teams.length + 56); } });
  g.font = bodyF(600, 17); g.fillStyle = T.muted; cols.forEach((c, i) => g.fillText(c[0] === 'principal' ? '' : c[2], 50 + teamW + i * cw + 8, top - 14));
  teams.forEach((t, r) => { const y = top + r * rowH; g.fillStyle = f1Colour(t.id); g.fillRect(50, y + 4, 8, rowH - 8); g.fillStyle = '#FFFFFF'; fitText(g, t.name, z => cond(700, z), 30, teamW - 30); g.fillText(t.name, 70, y + rowH / 2 + 10);
    cols.forEach(([role, car], i) => { const s = seatFor(t.id, role, car); if (!s) return; const st = seatState(s), o = f1Occupant(s), x = 50 + teamW + i * cw + 4, w = cw - 8, h = rowH - 8;
      g.fillStyle = KEY[st][0]; g.fillRect(x, y + 4, w, h); g.strokeStyle = KEY[st][1]; g.lineWidth = st === 'P' || st === 'O' ? 3 : 1; g.strokeRect(x + 1, y + 5, w - 2, h - 2);
      const nm = st === 'V' ? '–' : !o.person && !o.charId ? 'Open post' : o.name; g.fillStyle = st === 'V' ? '#8A8F98' : '#FFFFFF'; fitText(g, nm, z => bodyF(700, z), 22, w - 20); g.fillText(nm, x + 10, y + 4 + h / 2 + (st === 'V' ? 8 : 0));
      if (st !== 'V') { g.font = bodyF(500, 15); g.fillStyle = st === 'P' ? '#FF8A80' : st === 'O' ? '#7CD69C' : '#A7ABB3'; g.fillText(st === 'O' ? 'Open for applications' : KEY[st][2], x + 10, y + 4 + h / 2 + 22); } }); });
  g.font = bodyF(500, 18); g.fillStyle = T.muted; g.textAlign = 'right'; g.fillText(`Updated ${stampText()}`, W - 50, H - 26); g.textAlign = 'left';
  return new Promise(ok => cv.toBlob(ok, 'image/png'));
}
async function postGrid(sid) {
  const api = await window.claude.use('discord'), chans = await discordChannels().catch(() => ['default']), ch = gridChannel(sid, chans), doc = gridDoc(sid);
  const blob = await drawGridImage(sid), file = { blob, name: `${sid}-grid.png` }, payload = { content: `**${seriesDoc(sid).name} grid**, ${seasonDoc(curSeasonId(sid)).name} season\n-# Kept up to date by F1 SIM · last change <t:${Math.floor(Date.now() / 1000)}:R>` };
  let r, edited = false;
  if (doc.messageId && doc.channel === ch) { try { r = await api.post({ channel: ch, payload, file, edit: doc.messageId }); edited = true; } catch (e) { if (e.code !== 'gone') throw e; } }
  if (!r) r = await api.post({ channel: ch, payload, file });
  await Data.put('f1_settings', `discord-grid-${sid}`, Object.assign({}, clone(gridDoc(sid)), { messageId: (r && r.messageId) || doc.messageId || null, channel: ch, at: nowIso() }));
  return { ch, edited };
}
ACTIONS['grid-post'] = () => { if (!S.isGm) return; const sid = curSeriesId();
  run(async () => { const x = await postGrid(sid); S.ui.gridPosted = x; await Data.audit('discord.grid', `${seriesDoc(sid).name} grid ${x.edited ? 'updated' : 'posted'} on Discord #${x.ch}`); }, 'Done: the grid is on Discord.'); };
let gridTimer = null;
function gridChanged(sid) { if (!S.isGm || !gridDoc(sid).auto) return; clearTimeout(gridTimer); gridTimer = setTimeout(() => postGrid(sid).then(x => toast(`Discord grid ${x.edited ? 'updated' : 'posted'} in #${x.ch}.`)).catch(e => toast(`The Discord grid didn’t update: ${e.message || e}`, true)), 4000); }
const _f1AssignGrid = f1Assign;
f1Assign = async function (seatId, charId) { const s = get('f1_seats', seatId), sid = s ? ((get('f1_teams', s.teamId) || {}).seriesId || 'f1') : null; const r = await _f1AssignGrid(seatId, charId); if (sid) gridChanged(sid); return r; };
const _seatOpenGrid = ACTIONS['seat-open'];
ACTIONS['seat-open'] = d => { const s = get('f1_seats', d.id); _seatOpenGrid(d); if (s) gridChanged((get('f1_teams', s.teamId) || {}).seriesId || 'f1'); };

/* ---------------------------------------------------------------- open or close every seat in the series on screen */
function setAllSeats(open) {
  const sid = curSeriesId(), seats = F1.teams().flatMap(t => F1.seats(t.id)).filter(s => !s.holderCharId && !!s.open !== open);
  if (!seats.length) { toast(open ? 'Every free seat is already open.' : 'No seats are open.'); return; }
  askConfirm(open ? `Open ${plural(seats.length, 'seat')} for applications? Seats players hold aren’t affected.` : `Close ${plural(seats.length, 'seat')} to applications? Applications already sent stay with Race Control.`, open ? 'Open them' : 'Close them', () => run(async () => {
    for (const s of seats) await Data.put('f1_seats', s.id, Object.assign(clone(S.store.f1_seats[s.id]), { open }));
    await Data.audit('seats.bulk', `${seriesDoc(sid).name}: ${plural(seats.length, 'seat')} ${open ? 'opened for' : 'closed to'} applications`);
    gridChanged(sid);
  }, open ? 'Seats open for applications.' : 'Seats closed to applications.'), !open);
}
ACTIONS['seats-open-all'] = () => { if (S.isGm) setAllSeats(true); };
ACTIONS['seats-close-all'] = () => { if (S.isGm) setAllSeats(false); };

/* =====================================================================
   F1 SIM — the top navigation bar.
   Category menus in the top bar: Formula (the series raced in F1 SIM,
   then other single-seater championships), Endurance, Rally and
   Touring. Choosing a Formula series switches the whole site to it;
   championships not raced in F1 SIM open their leaderboards from career
   records. Pages that depend on the series get a strip under the title
   to switch between the Formula series.
   ===================================================================== */
'use strict';

const NAV_CATS = [['formula', 'GP', 'Single-seaters'], ['indy', 'IndyCar', 'Indy'], ['endurance', 'Endurance', 'Endurance'], ['rally', 'Rally', 'Rally'], ['touring', 'Touring', 'Touring']];
const INDY = ['IndyCar', 'Indy NXT', 'Indy Lights'];
const catSeries = group => group === 'Indy' ? INDY.slice() : ((CAREER_GROUPS.find(g => g[0] === group) || [])[1] || []).filter(x => x !== 'Other' && (group !== 'Single-seaters' || INDY.indexOf(x) === -1));
const catOfChamp = name => { if (INDY.indexOf(name) !== -1) return 'indy'; const g = CAREER_GROUPS.find(x => x[1].indexOf(name) !== -1); const c = g && NAV_CATS.find(k => k[2] === g[0]); return c ? c[0] : 'formula'; };
function onRecord(name) { return list('characters').filter(c => !c.retired && charApproved(c) && careerRows(c).some(r => r.status === 'canon' && seriesLabel(r) === name)).length; }
function activeCat() { if (S.route === 'endurance') return 'endurance'; return S.route === 'champ' && S.ui.champ && S.ui.champ.kind === 'canon' ? catOfChamp(S.ui.champ.key) : 'formula'; }
function topNavHtml() {
  const league = allSeries().length ? allSeries() : [curSeries()], cur = curSeriesId(), act = activeCat(), leagueNames = new Set(league.map(s => s.name));
  const champBtn = name => { const n = onRecord(name), on = act !== 'formula' && S.ui.champ && S.ui.champ.key === name;
    return `<button class="tn-item ${on ? 'on' : ''}" data-act="champ-open" data-kind="canon" data-key="${esc(name)}"><span>${esc(name)}</span><small>${n ? plural(n, 'character') + ' on record' : 'No records yet'}</small></button>`; };
  return `<nav class="topnav" aria-label="Championships">${NAV_CATS.map(([k, label, group]) => {
    const on = act === k, others = catSeries(group).filter(n => !leagueNames.has(n));
    const sum = k === 'formula' ? `${esc(label)}<b>${esc(curSeries().name)}</b>` : `${esc(label)}${on && S.route === 'endurance' ? '<b>Simulator</b>' : on && S.ui.champ ? `<b>${esc(S.ui.champ.key)}</b>` : ''}`;
    const panel = k === 'formula'
      ? `<p class="tn-h">Racing in F1 SIM</p>${league.map(s => `<button class="tn-item ${s.id === cur && act === 'formula' ? 'on' : ''}" data-act="nav-series" data-id="${esc(s.id)}"><span><i style="background:${esc(s.color || '#E10600')}"></i>${esc(s.name)}</span><small>${s.id === cur ? 'Showing now' : 'Switch the site to it'}</small></button>`).join('')}
        ${S.isGm ? '<button class="tn-item tn-link" data-act="nav" data-route="series"><span>Set up a series</span></button>' : ''}
        <p class="tn-h">Other championships <span>career records</span></p>${others.map(champBtn).join('')}`
      : (k === 'endurance' ? `<p class="tn-h">The simulator</p><button class="tn-item tn-sim ${S.route === 'endurance' ? 'on' : ''}" data-act="nav" data-route="endurance"><span>Endurance racing</span><small>In development · roadmap and the 2027 WEC</small></button><p class="tn-h">Championships <span>career records</span></p>` : `<p class="tn-note">Not raced in F1 SIM yet. Each opens its leaderboard and champions from characters’ career records.</p>`) + others.map(champBtn).join('');
    return `<details class="tn-menu ${on ? 'on' : ''}"><summary>${sum}</summary><div class="tn-panel" role="menu">${panel}</div></details>`; }).join('')}</nav>`;
}
ACTIONS['nav-series'] = d => {
  CHANGES['series-switch'](d.id); S.ui.teamsSeries = null;
  if (['champ', 'teamview', 'career', 'character', 'series'].indexOf(S.route) !== -1) go('grid'); else render();
};
/* Only one menu open at a time; a click elsewhere closes them. */
if (!window.__tnWired) { window.__tnWired = true;
  document.addEventListener('toggle', e => { const t = e.target; if (t && t.classList && t.classList.contains('tn-menu') && t.open) document.querySelectorAll('.tn-menu[open]').forEach(x => { if (x !== t) x.removeAttribute('open'); }); }, true);
  document.addEventListener('click', e => { if (!e.target.closest || !e.target.closest('.tn-menu')) document.querySelectorAll('.tn-menu[open]').forEach(x => x.removeAttribute('open')); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') document.querySelectorAll('.tn-menu[open]').forEach(x => { x.removeAttribute('open'); const s = x.querySelector('summary'); if (s) s.focus(); }); });
}

/* ---------------------------------------------------------------- the series strip on series pages */
const SERIES_PAGES = ['grid', 'team', 'weekend', 'calendar', 'standings', 'seasons', 'teams', 'test'];
function seriesStripHtml() {
  const all = allSeries(); if (all.length < 2) return '';
  return `<nav class="series-strip" aria-label="Formula series"><span>Formula</span>${all.map(s => `<button class="${s.id === curSeriesId() ? 'on' : ''}" aria-pressed="${s.id === curSeriesId()}" data-act="nav-series" data-id="${esc(s.id)}" style="--sc:${esc(s.color || '#E10600')}">${esc(s.name)}</button>`).join('')}</nav>`;
}
SERIES_PAGES.forEach(r => { if (!ROUTES[r]) return; const v = ROUTES[r].view;
  ROUTES[r].view = function () { const h = v.apply(this, arguments); if (r === 'standings' && (S.ui.standView || 'hub') === 'hub') return h; return seriesStripHtml() + h; }; });
/* A championship not raced in F1 SIM says so. */
const _champViewNav = ROUTES.champ.view;
ROUTES.champ.view = function () {
  const h = _champViewNav(); const x = S.ui.champ;
  if (!x || x.kind !== 'canon') return h;
  const note = `<div class="card notice tn-coming"><p><b>${esc(x.key)} isn’t raced in F1 SIM yet.</b> This page shows its leaderboard and champions from characters’ career records. ${catOfChamp(x.key) === 'formula' ? '' : 'Racing it in the league would need its own simulation.'}</p></div>`;
  const i = h.indexOf('<section'); return i < 0 ? h + note : h.slice(0, i) + note + h.slice(i);
};

/* =====================================================================
   F1 SIM — championship history: who raced, and when.
   Championship → Career: every championship has three views. Timeline:
   a row per person and a block per season (the team's colour for F1 SIM
   seasons, striped for career records), with finishes, titles and team
   roles. Calendar: decades as rows and years as tiles, each with its
   champion and how many raced; a year opens its roll call. Standings:
   the career standings by role, as before.
   ===================================================================== */
'use strict';

const yearsIn = txt => { const n = String(txt || '').match(/\b(19|20)\d{2}\b/g); if (!n) return []; const a = Number(n[0]), b = Number(n[n.length - 1]); const out = []; for (let y = Math.min(a, b); y <= Math.max(a, b) && out.length < 40; y++) out.push(y); return out; };
const teamColByName = nm => { const s = String(nm || '').toLowerCase(); const t = s && list('f1_teams').find(x => s.indexOf(String(x.name).toLowerCase()) !== -1); return t ? f1Colour(t.id) : null; };
const ROLE_SHORT = { principal: 'TP', director: 'Dir.', engineer: 'Eng.', strategist: 'Strat.', consultant: 'Cons.', other: 'Team' };
function histChamps() {
  const names = new Set(allSeries().map(s => s.name));
  list('characters').filter(c => !c.retired && charApproved(c)).forEach(c => careerRows(c).filter(r => r.status === 'canon').forEach(r => names.add(seriesLabel(r))));
  const league = allSeries().map(s => s.name);
  return league.concat([...names].filter(n => league.indexOf(n) === -1).sort());
}
/* Every season anyone had in a championship: F1 SIM seasons from the results, the rest from career records. */
function histEntries(name) {
  const out = [], s = allSeries().find(x => x.name === name), tname = id => (get('f1_teams', id) || {}).name || '';
  if (s) seriesSeasons(s.id).forEach(sea => {
    const yr = parseInt(sea.name, 10); if (!yr) return;
    const st = standingsFor(s.id, sea.id), done = seasonDone(sea.id);
    st.drivers.forEach((d, i) => out.push({ pid: d.personId, name: d.name, charId: d.charId || null, year: yr, team: tname(d.teamId), col: f1Colour(d.teamId), role: 'driver', pos: i + 1, champ: done && i === 0, lead: !done && i === 0, src: 'sim', soFar: !done }));
    const last = list('f1_weekends').filter(w => w.status === 'finished' && w.staff && wSeries(w) === s.id && wSeason(w) === sea.id).sort((a, b) => String(b.finishedAt).localeCompare(String(a.finishedAt)))[0];
    if (last) Object.keys(last.staff).forEach(tid => { const x = last.staff[tid] || {}, add = (who, role, car) => { if (!who || !who.charId) return; const pid = staffPid(who);
        out.push({ pid, name: (F1.person(pid) || {}).name || '', charId: who.charId, year: yr, team: tname(tid), col: f1Colour(tid), role, car, src: 'sim', soFar: !done }); };
      add(x.principal, 'principal'); Object.keys(x.engineers || {}).forEach(car => add(x.engineers[car], 'engineer', car)); });
  });
  list('characters').filter(c => !c.retired && charApproved(c)).forEach(c => careerRows(c).filter(r => r.status === 'canon' && seriesLabel(r) === name).forEach(r => yearsIn(r.years).forEach(yr => {
    if (out.some(e => e.pid === f1PcId(c.id) && e.year === yr && e.src === 'sim')) return;
    const pos = String(r.pos || ''), n = Number(pos);
    out.push({ pid: f1PcId(c.id), name: c.name, charId: c.id, year: yr, team: r.team || '', col: teamColByName(r.team), role: r.role || 'driver', pos: n >= 1 && n <= 10 ? n : null, posTxt: pos === '11' ? 'P11+' : pos === '0' ? 'Part' : '', champ: pos === '1', src: 'record' }); })));
  return out;
}
const histFilter = es => { const sh = S.ui.histShow || 'all'; return es.filter(e => sh === 'all' || (sh === 'players' ? !!e.charId : !e.charId)); };
const cellLabel = e => e.role !== 'driver' ? (ROLE_SHORT[e.role] || 'Team') : e.champ ? '★' : e.pos ? `P${e.pos}` : (e.posTxt || '•');

/* ---------------------------------------------------------------- the view */
CHANGES['hist-champ'] = v => { S.ui.histChamp = v; S.ui.histYear = null; render(); };
CHANGES['hist-show'] = v => { S.ui.histShow = v; render(); };
CHANGES['hist-range'] = v => { S.ui.histRange = v; render(); };
ACTIONS['hist-tab'] = d => { S.ui.histTab = d.t; render(); };
ACTIONS['hist-year'] = d => { S.ui.histYear = Number(d.y); render(); setTimeout(() => { const el = document.getElementById('hist-year-detail'); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, 60); };
function timelineHtml(es, name) {
  if (!es.length) return `<p class="muted">Nobody has raced in ${esc(name)} yet, in F1 SIM or on an accepted career record.</p>`;
  let ys = [...new Set(es.map(e => e.year))], lo = Math.min(...ys), hi = Math.max(...ys);
  const range = S.ui.histRange || 'all'; if (range !== 'all') lo = Math.max(lo, hi - Number(range) + 1);
  const years = []; for (let y = lo; y <= hi; y++) years.push(y);
  const simStart = Math.min(...es.filter(e => e.src === 'sim').map(e => e.year).concat([9999]));
  const people = new Map(); es.forEach(e => { if (e.year < lo) return; const k = `${e.pid}|${e.role === 'driver' ? 'd' : 's'}`; const p = people.get(k) || { pid: e.pid, name: e.name, charId: e.charId, staff: e.role !== 'driver', by: {}, teams: new Set(), first: e.year, last: e.year, best: 99, titles: 0 };
    p.by[e.year] = e; if (e.team) p.teams.add(e.team); p.first = Math.min(p.first, e.year); p.last = Math.max(p.last, e.year); if (e.pos) p.best = Math.min(p.best, e.pos); if (e.champ) p.titles++; people.set(k, p); });
  const rows = staff => [...people.values()].filter(p => p.staff === staff).sort((a, b) => a.first - b.first || b.titles - a.titles || a.name.localeCompare(b.name));
  const cell = (p, y) => { const e = p.by[y], cls = y === simStart ? ' tl-simstart' : ''; if (!e) return `<td class="tl-c${cls}"></td>`;
    const bg = e.src === 'record' ? '' : `style="--tc:${esc(e.col || '#565A63')}"`, label = cellLabel(e), tip = `${y}: ${e.team || ''} · ${e.role === 'driver' ? (e.champ ? 'champion' : e.pos ? 'P' + e.pos : e.posTxt || 'raced') : careerRoleName(e.role)}${e.soFar ? ' (so far)' : ''}${e.src === 'record' ? ' (career record)' : ''}`;
    return `<td class="tl-c${cls}"><span class="tl-b ${e.src === 'record' ? 'rec' : 'sim'} ${e.champ ? 'champ' : ''}" ${bg} title="${esc(tip)}">${esc(label)}</span></td>`; };
  const rowHtml = p => `<tr${S.charId && p.charId === S.charId ? ' class="me"' : ''}><th scope="row" class="tl-who">${careerLink(p.pid, p.name)}${p.charId ? ' <span class="tag player">Player</span>' : ''}<small><b>${p.first === p.last ? p.first : `${p.first}–${p.last}`}</b> · ${esc([...p.teams].slice(0, 2).join(', '))}${p.teams.size > 2 ? ` +${p.teams.size - 2}` : ''}${p.titles ? ` · ${plural(p.titles, 'title')}` : p.best < 99 ? ` · best P${p.best}` : ''}</small></th>${years.map(y => cell(p, y)).join('')}</tr>`;
  const group = (title, cls, rs) => rs.length ? `<tr class="tl-group ${cls}"><th scope="rowgroup" class="tl-who">${esc(title)}</th><td colspan="${years.length}"></td></tr>${rs.map(rowHtml).join('')}` : '';
  /* Open at the most recent years: scroll left to go back in time. */
  setTimeout(() => { const w = document.querySelector('.tl-wrap'); if (w) w.scrollLeft = w.scrollWidth; }, 0);
  return `<div class="tl-key"><span><i class="tl-b sim" style="--tc:#E10600"></i>F1 SIM season, in the team’s colour</span><span><i class="tl-b rec"></i>Career record (before F1 SIM)</span><span><b class="gold">★</b> Champion</span><span>P5 = championship finish · TP, Eng., Dir., Cons. = team roles</span>${years.some(y => es.some(e => e.year === y && e.soFar)) ? `<span>${hi}* = so far</span>` : ''}</div>
    <div class="scroll-x tl-wrap"><table class="tl"><thead><tr><th class="tl-who">Name</th>${years.map(y => `<th class="tl-y${y === simStart ? ' tl-simstart' : ''}">${y}${es.some(e => e.year === y && e.soFar) ? '*' : ''}</th>`).join('')}</tr></thead>
    <tbody>${group('Drivers', 'd', rows(false))}${group('Team principals, race engineers and other team roles', 's', rows(true))}</tbody></table></div>`;
}
function calendarHtml(es, name) {
  if (!es.length) return `<p class="muted">Nobody has raced in ${esc(name)} yet, in F1 SIM or on an accepted career record.</p>`;
  const ys = es.map(e => e.year), lo = Math.floor(Math.min(...ys) / 10) * 10, hi = Math.floor(Math.max(...ys) / 10) * 10;
  const by = y => es.filter(e => e.year === y), sel = S.ui.histYear && ys.indexOf(S.ui.histYear) !== -1 ? S.ui.histYear : Math.max(...ys);
  const tile = y => { const x = by(y), drv = x.filter(e => e.role === 'driver'); if (!x.length) return `<div class="cal-y empty"><b>${y}</b></div>`;
    const sim = x.some(e => e.src === 'sim'), ch = drv.find(e => e.champ), ld = drv.find(e => e.lead), players = new Set(x.filter(e => e.charId).map(e => e.pid)).size;
    return `<button class="cal-y ${sim ? 'sim' : 'rec'} ${y === sel ? 'on' : ''}" data-act="hist-year" data-y="${y}" aria-pressed="${y === sel}"><b>${y}${x.some(e => e.soFar) ? '*' : ''}</b>
      <span class="cal-ch" title="${esc(ch ? ch.name : ld ? ld.name : '')}">${ch ? `★ ${esc(ch.name.split(' ').pop())}` : ld ? `Leads: ${esc(ld.name.split(' ').pop())}` : '&nbsp;'}</span><small>${[drv.length ? plural(new Set(drv.map(e => e.pid)).size, 'driver') : '', x.some(e => e.role !== 'driver') ? `${new Set(x.filter(e => e.role !== 'driver').map(e => e.pid)).size} in a team role` : '', players ? `${players} player${players === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ')}</small></button>`; };
  const decades = []; for (let d = hi; d >= lo; d -= 10) decades.push(d);
  const x = by(sel), drv = x.filter(e => e.role === 'driver').sort((a, b) => (a.pos || 99) - (b.pos || 99) || a.name.localeCompare(b.name)), staff = x.filter(e => e.role !== 'driver'), ch = drv.find(e => e.champ) || drv.find(e => e.lead), sim = x.some(e => e.src === 'sim');
  const chip = e => `<span class="cal-p ${S.charId && e.charId === S.charId ? 'me' : ''}" style="--tc:${esc(e.col || '#565A63')}">${careerLink(e.pid, e.name)}<small>${esc(e.team || '–')} · ${esc(e.role === 'driver' ? (e.champ ? 'Champion' : e.pos ? 'P' + e.pos : e.posTxt || 'raced') : careerRoleName(e.role))}</small>${e.charId ? '<span class="tag player">Player</span>' : ''}</span>`;
  return `<div class="cal">${decades.map(d => `<div class="cal-dec"><span class="cal-dlabel">${d}s</span><div class="cal-years">${Array.from({ length: 10 }, (_, i) => tile(d + i)).join('')}</div></div>`).join('')}</div>
    <section class="card cal-detail" id="hist-year-detail"><div class="cal-dhead"><h2>${sel}${x.some(e => e.soFar) ? ' (so far)' : ''}</h2><span class="tag ${sim ? 'league' : ''}">${sim ? 'F1 SIM' : 'Career records'}</span></div>
      ${ch ? `<p class="cal-champ"><b class="gold">★</b> <span class="muted small">${ch.champ ? 'Champion' : 'Leading'}</span> <b>${esc(ch.name)}</b> <span class="muted">${esc(ch.team || '')}</span></p>` : ''}
      ${drv.length ? `<div class="cal-people">${drv.map(chip).join('')}</div>` : ''}
      ${staff.length ? `<p class="small"><b class="cal-staff-h">Running the teams:</b></p><div class="cal-people">${staff.map(chip).join('')}</div>` : ''}
      ${!sim ? '<p class="muted small">Before F1 SIM: the characters whose accepted career records include this year. Real-world champions aren’t recorded here.</p>' : ''}</section>`;
}
function historyViewHtml() {
  const names = histChamps(), name = S.ui.histChamp && names.indexOf(S.ui.histChamp) !== -1 ? S.ui.histChamp : curSeries().name, tab = S.ui.histTab || 'timeline';
  const es = histFilter(histEntries(name));
  const sel = (id, act, val, opts, label) => `<label class="hist-f">${esc(label)}<select id="${id}" data-change="${act}">${opts.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(val) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`;
  const filters = `<div class="hist-bar">${sel('hist-champ', 'hist-champ', name, names.map(n => [n, n + (allSeries().some(s => s.name === n) ? '' : ' (career records)')]), 'Championship')}
    ${sel('hist-show', 'hist-show', S.ui.histShow || 'all', [['all', 'Everyone'], ['players', 'Players only'], ['real', 'Real drivers']], 'Show')}
    ${tab === 'timeline' ? sel('hist-range', 'hist-range', S.ui.histRange || 'all', [['all', 'All years'], ['10', 'Last 10 years'], ['20', 'Last 20 years']], 'Years') : ''}</div>`;
  return `<div class="seg hist-tabs" role="tablist" aria-label="View">${[['timeline', 'Timeline'], ['calendar', 'Calendar'], ['standings', 'Standings']].map(([k, l]) => `<button role="tab" aria-selected="${tab === k}" data-act="hist-tab" data-t="${k}">${esc(l)}</button>`).join('')}</div>
    ${tab === 'standings' ? '' : filters + `<h2 class="hist-title">${tab === 'timeline' ? `Who raced in ${esc(name)}, and when` : `${esc(name)}, year by year`}</h2>` + (tab === 'timeline' ? timelineHtml(es, name) : calendarHtml(es, name))}`;
}
const _standingsViewHistory = ROUTES.standings.view;
ROUTES.standings.view = function () {
  if ((S.ui.standView || 'hub') !== 'career') return _standingsViewHistory();
  const h = _standingsViewHistory(), tab = S.ui.histTab || 'timeline', body = historyViewHtml();
  const at = h.indexOf('</div>', h.indexOf('class="seg stand-tabs"'));
  if (tab === 'standings') return at < 0 ? body + h : h.slice(0, at + 6) + body + h.slice(at + 6);
  const head = `<div class="page-head"><div><h1>Championship</h1><p>Who raced in each championship and when: F1 SIM seasons, and accepted career records from before the league.</p></div></div>`;
  const tabsEnd = h.indexOf('</div>', h.indexOf('class="seg stand-tabs"')), tabsStart = h.indexOf('<div class="seg stand-tabs"');
  return head + (tabsStart >= 0 ? h.slice(tabsStart, tabsEnd + 6) : '') + body;
};

/* =====================================================================
   F1 SIM v1.0.0 — the start of the expansion beyond Grand Prix racing.
   Planned testing on every series' calendar: pre-season tests (circuit,
   days, date) that Race Control can add, date, remove and open, so the
   calendar shows every time the cars will be on track.
   The Endurance section: the home of the endurance simulator. Phase 1
   shows the roadmap, the 2027 FIA WEC season and its classes, and the
   endurance championships from career records.
   ===================================================================== */
'use strict';

/* ---------------------------------------------------------------- planned testing */
const DEFAULT_TESTS = { f1: [['bahrain', 3]], f2: [['bahrain', 3]], f3: [['spain', 3]] };
function seriesTests(s) {
  if (Array.isArray(s.tests)) return s.tests;
  const d = DEFAULT_TESTS[s.template || s.id] || (F1.tracks()[0] ? [[F1.tracks()[0].id, 3]] : []);
  return d.map(([trackId, days], i) => ({ id: `t${i + 1}`, name: 'Pre-season test', trackId, days, date: '' }));
}
async function saveTests(s, tests) {
  await Data.put('f1_series', s.id, Object.assign(get('f1_series', s.id) ? clone(S.store.f1_series[s.id]) : { template: s.id, activeSeason: curSeasonId() }, { tests }));
}
ACTIONS['test-plan-add'] = () => { if (!S.isGm) return; const s = curSeries(), t = seriesTests(s), track = F1.tracks()[0];
  run(async () => { await saveTests(s, t.concat([{ id: newId('tp'), name: t.length ? 'Test' : 'Pre-season test', trackId: track ? track.id : '', days: 2, date: '' }])); }, 'Test session added: set its circuit, days and date.'); };
ACTIONS['test-plan-remove'] = d => { if (!S.isGm) return; const s = curSeries();
  askConfirm('Remove this test session from the calendar? Anything already run there stays in the record.', 'Remove it', () => run(async () => { await saveTests(s, seriesTests(s).filter(x => x.id !== d.id)); }, 'Removed.'), true); };
CHANGES['test-plan-field'] = (v, d) => { if (!S.isGm) return; const s = curSeries(), k = d.k;
  const val = k === 'days' ? Math.max(1, Math.min(5, Number(v) || 1)) : String(v || '').slice(0, k === 'name' ? 40 : 20);
  run(async () => { await saveTests(s, seriesTests(s).map(x => x.id === d.id ? Object.assign({}, x, { [k]: val }) : x)); }); };
ACTIONS['test-plan-open'] = d => { if (!S.isGm) return; const x = seriesTests(curSeries()).find(t => t.id === d.id); if (!x) return;
  S.ui.form.f1w = Object.assign({}, S.ui.form.f1w || {}, { trackId: x.trackId, session: 'test' }); S.ui.f1view = null; go('weekend');
  toast(`Testing at ${(F1.track(x.trackId) || {}).name || 'the circuit'} is set up below: choose the weather, then open it.`); };
function plannedTestsHtml(s, played, filter) {
  const plan = seriesTests(s).slice().sort((a, b) => String(a.date || '9999').localeCompare(String(b.date || '9999'))), edit = S.isGm && S.ui.calEdit, used = new Set();
  const cards = plan.map(x => { const t = F1.track(x.trackId) || {}, w = played.find(p => p.trackId === x.trackId && !used.has(p.id)); if (w) used.add(w.id);
    const state = !w ? 'planned' : w.status === 'finished' ? 'done' : 'live';
    if (filter === 'done' && state !== 'done') return ''; if (filter === 'tocome' && state === 'done') return '';
    const fields = edit ? `<div class="test-edit"><label class="field">Name<input type="text" value="${esc(x.name)}" data-change="test-plan-field" data-id="${esc(x.id)}" data-k="name"></label>
        <label class="field">Circuit<select data-change="test-plan-field" data-id="${esc(x.id)}" data-k="trackId">${F1.tracks().map(tt => `<option value="${esc(tt.id)}" ${tt.id === x.trackId ? 'selected' : ''}>${esc(tt.name)}</option>`).join('')}</select></label>
        <label class="field">Days<input type="number" min="1" max="5" value="${esc(x.days)}" data-change="test-plan-field" data-id="${esc(x.id)}" data-k="days"></label>
        <label class="field">First day<input type="date" value="${esc(x.date || '')}" data-change="test-plan-field" data-id="${esc(x.id)}" data-k="date"></label>
        <button class="btn small ghost" data-act="test-plan-remove" data-id="${esc(x.id)}">Remove</button></div>` : '';
    return `<article class="cal-card test ${state}"><header><span class="cal-round">Testing</span>${state === 'done' ? '<span class="tag">Done</span>' : state === 'live' ? '<span class="tag live">On now</span>' : '<span class="tag">Planned</span>'}</header>
      <h2>${esc(t.flag || '')} ${esc(x.name)}</h2><p class="muted small">${esc(t.circuit || t.name || 'Circuit to be set')} · ${plural(x.days, 'day')}${x.date ? ` · from ${esc(fmtDay(x.date))}` : ' · date to be set'}${w ? ` · ${plural(endedSessions(w).length, 'day')} run` : ''}</p>${fields}
      <div class="btn-row">${w ? `<button class="btn small ${state === 'done' ? 'primary' : ''}" data-act="cal-open" data-id="${esc(w.id)}">${state === 'done' ? 'See the timesheets' : 'Go to testing'}</button>` : S.isGm ? `<button class="btn small" data-act="test-plan-open" data-id="${esc(x.id)}">Open testing</button>` : ''}</div></article>`; }).join('');
  /* Tests run somewhere that wasn't planned still show. */
  const extra = played.filter(w => !used.has(w.id)).map(w => { const t = get('f1_tracks', w.trackId) || {};
    return `<article class="cal-card test ${w.status === 'finished' ? 'done' : 'live'}"><header><span class="cal-round">Testing</span>${w.status === 'finished' ? '<span class="tag">Done</span>' : '<span class="tag live">On now</span>'}</header><h2>${esc(t.flag || '')} Testing</h2><p class="muted small">${esc(t.circuit || t.name || '')}. ${plural(endedSessions(w).length, 'day')} run.</p><div class="btn-row"><button class="btn small" data-act="cal-open" data-id="${esc(w.id)}">See the timesheets</button></div></article>`; }).join('');
  const add = edit ? '<article class="cal-card test add"><button class="btn" data-act="test-plan-add">Add a test session</button><p class="muted small">Pre-season or in-season testing, at any circuit.</p></article>' : '';
  return cards + extra + add;
}

/* ---------------------------------------------------------------- the Endurance section */
const WEC_2027 = [['Prologue', 'Official Prologue (group test)', 'Lusail, Qatar', '21–22 March', 'test'], ['1', 'Qatar 1812km', 'Lusail, Qatar', '25–27 March', '1812 km'], ['2', '6 Hours of Imola', 'Imola, Italy', '9–11 April', '6 hours'],
  ['3', '6 Hours of Silverstone', 'Silverstone, Britain', '23–25 April', '6 hours'], ['4', '6 Hours of Spa-Francorchamps', 'Spa, Belgium', '13–15 May', '6 hours'], ['5', '24 Hours of Le Mans', 'Circuit de la Sarthe, France', '9–13 June', '24 hours'],
  ['6', '6 Hours of São Paulo', 'Interlagos, Brazil', '9–11 July', '6 hours'], ['7', 'Lone Star Le Mans', 'Circuit of the Americas, USA', '10–12 September', '6 hours'], ['8', '6 Hours of Fuji', 'Fuji Speedway, Japan', '24–26 September', '6 hours'], ['9', '8 Hours of Bahrain', 'Bahrain', '4–6 November', '8 hours']];
const ENDURANCE_PHASES = [
  ['1', 'The Endurance section', 'This page, the menu entry, the roadmap, the 2027 WEC season and classes, and the endurance career records.', 'done'],
  ['2', 'Endurance series and grid', 'A WEC series: Hypercar and LMGT3 classes, real teams and cars, three drivers per car, team principals and engineers, driver ratings by category (Platinum to Bronze), the calendar with race lengths, and the grid, teams and characters working for it.', 'next'],
  ['3', 'The endurance race engine', 'Timed races (6, 8, 10 or 24 hours), several classes on track at once with traffic and passing, fuel and tyre stints, driver stints and maximum drive time, day and night, weather through the race, slow zones, full-course yellows and safety cars, and Balance of Performance.', 'later'],
  ['4', 'The endurance race weekend', 'Practice, Hyperpole qualifying, a race in hours shown live, and the pit wall: stint plans, driver changes, fuel and tyre calls, and night running, with the three involvement levels.', 'later'],
  ['5', 'Le Mans and the other events', 'The 24 Hours of Le Mans with Test Day and LMP2, the Qatar 1812km, and a lighter European Le Mans Series and IMSA.', 'later'],
  ['6', 'Everything else, for endurance', 'Championships by class and for manufacturers, development and money, exports and Discord, race reports, records and the history views.', 'later']];
route('endurance', 'Endurance', function () {
  const ch = ['WEC', 'Le Mans 24 Hours', 'IMSA', 'European Le Mans Series', 'GT World Challenge'], status = { done: ['In place', 'player'], next: ['Next', 'open'], later: ['Planned', ''] };
  return `<div class="page-head"><div><p class="eyebrow">Endurance</p><h1>Endurance racing</h1><p>F1 SIM is expanding beyond Grand Prix racing. This is the home of the endurance simulator: built in phases, with everything the Grand Prix side has, plus what makes endurance racing its own.</p></div></div>
    <section class="card"><h2>The roadmap</h2><ol class="end-phases">${ENDURANCE_PHASES.map(([n, t, d, st]) => `<li class="end-phase ${st}"><span class="end-n">${n}</span><div><b>${esc(t)}</b> <span class="tag ${status[st][1]}">${status[st][0]}</span><p class="small">${esc(d)}</p></div></li>`).join('')}</ol></section>
    <div class="cols2" style="align-items:start">
      <section class="card"><h2>The 2027 FIA WEC season</h2><p class="muted small">Nine rounds and a pre-season test, as published by the FIA WEC on 12 June 2026. This is the calendar the simulator will race.</p>
        <div class="scroll-x"><table class="data compact"><thead><tr><th>Round</th><th>Event</th><th>Circuit</th><th>Dates</th><th>Length</th></tr></thead><tbody>${WEC_2027.map(([r, e, c, d, l]) => `<tr${l === 'test' ? ' class="muted"' : ''}><td>${esc(r)}</td><td><b>${esc(e)}</b></td><td>${esc(c)}</td><td>${esc(d)}</td><td>${esc(l === 'test' ? 'Testing' : l)}</td></tr>`).join('')}</tbody></table></div></section>
      <section class="card"><h2>The classes</h2>
        <div class="end-class" style="--cc:#E10600"><b>Hypercar</b><p class="small">The top class, for outright wins. 17 cars from eight manufacturers in 2026 (Alpine, Aston Martin, BMW, Cadillac, Ferrari, Genesis, Peugeot, Toyota); Ford and McLaren join in 2027.</p></div>
        <div class="end-class" style="--cc:#2FA84F"><b>LMGT3</b><p class="small">GT3 cars run by customer teams, with a mix of professional and amateur drivers in every crew. 18 cars from nine marques in 2026.</p></div>
        <div class="end-class" style="--cc:#5AA9FF"><b>LMP2</b><p class="small">Races at Le Mans (not the full WEC season), in the plan for Phase 5.</p></div>
        <p class="muted small">Each car has three drivers sharing it in stints.</p></section></div>
    <section class="card"><h2>Endurance championships on record</h2><p class="muted small">Until the simulator races them, these show the leaderboards and champions from characters’ career records.</p>
      <div class="btn-row">${ch.map(n => `<button class="btn small" data-act="champ-open" data-kind="canon" data-key="${esc(n)}">${esc(n)}</button>`).join('')}</div></section>`;
});
if (LIMITED_ROUTES.indexOf('endurance') === -1) LIMITED_ROUTES.push('endurance');

/* =====================================================================
   F1 SIM — deleting a character removes every record of them.
   Everything is keyed on the character's unique ID (and their grid ID,
   pc-<ID>): documents that belong to them are deleted; inside shared
   records (a finished race's results, timesheets, staff, catalogued
   seasons) their entries are taken out. Standings recalculate without
   them; everyone else keeps their own finishes and points.
   "Clean up leftovers" finds records pointing at characters that no
   longer exist and removes them the same way.
   ===================================================================== */
'use strict';

const REF_KEYS = ['charId', 'personId', 'pid', 'holderCharId', 'otherId', 'driverId', 'fromCharId', 'toCharId', 'byCharId', 'targetId', 'engineerId', 'principalId'];
const hasRef = (o, ids) => o && typeof o === 'object' && !Array.isArray(o) && REF_KEYS.some(k => typeof o[k] === 'string' && ids.has(o[k]));
/* Returns [pruned copy, changed]: array entries that are, or point at, one of the ids go; so do keys named after them,
   and fields holding them (an object pointing at them becomes null). */
function pruneDeep(v, ids) {
  if (Array.isArray(v)) { let ch = false; const out = [];
    for (const x of v) { if ((typeof x === 'string' && ids.has(x)) || hasRef(x, ids)) { ch = true; continue; } const [nx, c] = pruneDeep(x, ids); if (c) ch = true; out.push(nx); }
    return [out, ch]; }
  if (v && typeof v === 'object') { let ch = false; const out = {};
    for (const k of Object.keys(v)) { const x = v[k];
      if (ids.has(k)) { ch = true; continue; }
      if (typeof x === 'string' && ids.has(x)) { out[k] = null; ch = true; continue; }
      if (hasRef(x, ids)) { out[k] = null; ch = true; continue; }
      const [nx, c] = pruneDeep(x, ids); if (c) ch = true; out[k] = nx; }
    return [out, ch]; }
  return [v, false];
}
const idsFor = charIds => new Set(charIds.flatMap(id => [id, f1PcId(id)]));
/* What a purge would touch, without changing anything. */
function purgeScan(ids) {
  const out = { remove: [], edit: [], seats: [], results: 0 };
  for (const col of COLLECTIONS) { if (col === 'audit' || col === 'characters') continue;
    for (const [id, d] of Object.entries(S.store[col] || {})) {
      if (col === 'f1_seats') { if (ids.has(d.holderCharId)) out.seats.push(id); continue; }
      if (col === 'f1_teams' || col === 'f1_tracks') continue;
      if (ids.has(id) || hasRef(d, ids)) { out.remove.push([col, id]); continue; }
      const json = JSON.stringify(d); if (![...ids].some(x => json.indexOf(`"${x}"`) !== -1)) continue;
      out.edit.push([col, id]);
      if (col === 'f1_weekends') out.results += (d.results || []).filter(r => hasRef(r, ids)).length;
    } }
  return out;
}
async function purgeIds(ids, names) {
  const sc = purgeScan(ids);
  for (const sid of sc.seats) await Data.put('f1_seats', sid, Object.assign(clone(S.store.f1_seats[sid]), { holderCharId: null, holderName: null, holderSince: null, open: true }));
  for (const [col, id] of sc.remove) await Data.remove(col, id);
  for (const [col, id] of sc.edit) { const [nd, ch] = pruneDeep(clone(S.store[col][id]), ids); if (ch) await Data.put(col, id, nd); }
  /* Activity log lines naming them, unless another character still has that name. */
  const keep = new Set(list('characters').map(c => String(c.name).trim().toLowerCase()));
  for (const nm of names.filter(n => n && !keep.has(String(n).trim().toLowerCase())))
    for (const a of list('audit').filter(x => String(x.text || '').indexOf(nm) !== -1)) await Data.remove('audit', a.id);
  return sc;
}

/* ---------------------------------------------------------------- deleting a character */
ACTIONS['chdel-run'] = () => {
  const x = S.ui.chdel || {}, c = get('characters', x.id); if (!S.isGm || !c) return;
  const typed = String((document.getElementById('chdel-typed') || {}).value || x.typed || '').trim();
  if (typed.toLowerCase() !== String(c.name).trim().toLowerCase()) { toast(`Type ${c.name} exactly to confirm.`, true); return; }
  const fp = charFootprint(c); if (fp.live) { toast('Finish or cancel the open weekend first.', true); return; }
  const name = c.name, cid = c.id;
  run(async () => {
    await Data.remove('characters', cid);
    const sc = await purgeIds(idsFor([cid]), [name]);
    if (S.charId === cid) { S.charId = null; lsSet('f1sim.char', null); }
    if (S.ui.charEdit === cid) S.ui.charEdit = null;
    await Data.audit('character.delete', `A character (${cid}) was deleted by Race Control, with ${plural(sc.remove.length + sc.edit.length + sc.seats.length, 'record')}`);
    closeDrawer(); S.ui.chdel = null; if (S.route === 'character' || S.route === 'career') go('control');
  }, `${name} deleted, with every record of them.`);
};

/* ---------------------------------------------------------------- leftovers from characters that no longer exist */
function findOrphans() {
  const live = new Set(list('characters').map(c => c.id)), found = new Map();
  const note = (cid, name) => { if (!cid || live.has(cid)) return; const o = found.get(cid) || { id: cid, names: new Set() }; if (name) o.names.add(String(name)); found.set(cid, o); };
  const walk = v => { if (Array.isArray(v)) return v.forEach(walk); if (!v || typeof v !== 'object') return;
    if (typeof v.charId === 'string') note(v.charId, v.name || v.charName || v.holderName);
    if (typeof v.holderCharId === 'string') note(v.holderCharId, v.holderName);
    ['personId', 'pid'].forEach(k => { if (typeof v[k] === 'string' && v[k].indexOf('pc-') === 0) note(v[k].slice(3), v.name); });
    Object.values(v).forEach(walk); };
  for (const col of COLLECTIONS) { if (col === 'characters' || col === 'audit') continue; Object.entries(S.store[col] || {}).forEach(([id, d]) => { if (col === 'f1_people' && id.indexOf('pc-') === 0) note(id.slice(3), d.name); walk(d); }); }
  return [...found.values()].map(o => Object.assign(o, { names: [...o.names], scan: purgeScan(idsFor([o.id])) }));
}
ACTIONS['orphans-check'] = () => { if (!S.isGm) return; S.ui.orphans = findOrphans(); render(); };
ACTIONS['orphans-clean'] = () => { if (!S.isGm) return; const os = S.ui.orphans || []; if (!os.length) return;
  askConfirm(`Remove every record of ${plural(os.length, 'deleted character')}? This can’t be undone.`, 'Remove them', () => run(async () => {
    for (const o of os) await purgeIds(idsFor([o.id]), o.names);
    await Data.audit('cleanup.orphans', `Race Control removed the leftover records of ${plural(os.length, 'deleted character')}`);
    S.ui.orphans = findOrphans();
  }, 'Leftovers removed.'), true); };
function orphansHtml() {
  const os = S.ui.orphans;
  return `<section class="card"><h2>Clean up leftovers</h2><p class="muted small">Finds records still pointing at characters that no longer exist (from deletes before v1.0.1) and removes them, the same way deleting does now.</p>
    ${os === undefined ? '<button class="btn" data-act="orphans-check">Check for leftovers</button>'
      : !os.length ? '<p><b>Nothing left over.</b> Every record points at a character that exists.</p><button class="btn small ghost" data-act="orphans-check">Check again</button>'
      : `<ul class="orphans">${os.map(o => { const n = o.scan.results, other = o.scan.remove.length + o.scan.edit.length + o.scan.seats.length; return `<li><b>${esc(o.names[0] || 'Unnamed')}</b> <span class="muted small">(${esc(o.id)})</span>: ${n ? plural(n, 'race result') + ', ' : ''}${plural(other, 'record')}</li>`; }).join('')}</ul>
        <div class="btn-row"><button class="btn danger" data-act="orphans-clean">Remove them all</button><button class="btn ghost" data-act="orphans-check">Check again</button></div>`}</section>`;
}
const _controlViewOrphans = ROUTES.control.view;
ROUTES.control.view = function () { const h = _controlViewOrphans(); return S.isGm ? h + orphansHtml() : h; };

/* ---------------------------------------------------------------- the ID, shown where it's useful */
const _characterViewIds = ROUTES.character.view;
ROUTES.character.view = function () {
  const h = _characterViewIds(), c = get('characters', S.ui.charEdit);
  if (!c || !(S.isGm || c.userId === S.uid)) return h;
  return h + `<p class="muted small char-id">Character ID: <code>${esc(c.id)}</code> <button class="btn small ghost" data-act="copy-text" data-text="${esc(c.id)}">Copy</button></p>`;
};
if (!ACTIONS['copy-text']) ACTIONS['copy-text'] = d => { try { navigator.clipboard.writeText(d.text); toast('Copied.'); } catch (e) { toast('Couldn’t copy: select it instead.', true); } };

/* start-up: every part has registered its routes, drawers and actions */
init();
