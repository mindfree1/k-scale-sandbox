/*
  K-Scale Sandbox V0 (no framework).
  - Uses locked CONFIG from config.js
  - One-page app with queue + End Turn resolution
*/

const $ = (sel, root=document) => root.querySelector(sel);
const $$ = (sel, root=document) => Array.from(root.querySelectorAll(sel));

function clamp(x, lo, hi){ return Math.max(lo, Math.min(hi, x)); }
function fmt(n, digits=0){ return Number.isFinite(n) ? n.toFixed(digits) : "--"; }
function deepClone(obj){ return JSON.parse(JSON.stringify(obj)); }

// ---------- Game state ----------

const STORAGE_KEY = "k_scale_v0_save";

function newRun(){
  const base = deepClone(CONFIG.constants.startingState);
  return {
    turn: 1,
    credits: CONFIG.constants.startingCredits,
    researched: new Set(),
    // builtCounts is stored in earth.builtCounts; we'll also store it in a flat map for convenience.
    state: base,
    queue: [],
    lastSummary: null,
    lastEvent: null,
    lastReport: null,
    won: false,
    lost: false,
    lossReason: ""
  };
}

let RUN = loadRun() || newRun();

function saveRun(){
  const serializable = {
    ...RUN,
    researched: Array.from(RUN.researched)
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(serializable));
}

function loadRun(){
  try{
    const raw = localStorage.getItem(STORAGE_KEY);
    if(!raw) return null;
    const obj = JSON.parse(raw);
    obj.researched = new Set(obj.researched || []);
    return obj;
  }catch{ return null; }
}

// ---------- Derived helpers ----------

function hasTech(id){ return RUN.researched.has(id); }
function getBuildCount(buildId){
  return RUN.state.earth.builtCounts?.[buildId] || 0;
}
function hasBuilt(buildId){ return getBuildCount(buildId) > 0; }

function applyCostModifiers(baseCost, buildId){
  let cost = baseCost;
  for(const m of RUN.state.flags.activeCostModifiers){
    if(m.targetBuildId === buildId && m.remainingTurns > 0){
      cost += m.addCost;
    }
  }
  return cost;
}

function weightedPick(items){
  const total = items.reduce((s,it)=>s+(it.weight||0),0);
  let r = Math.random()*total;
  for(const it of items){
    r -= (it.weight||0);
    if(r <= 0) return it;
  }
  return items[items.length-1];
}

function sumOrbit(){
  const parts = RUN.state.space.orbitParts;
  let orbitPowerMW = 0;
  let radiatorMWth = 0;
  let computeLoadMW_std = 0;
  let computeLoadMW_rh = 0;
  let hasComms = false;
  let hasServicing = false;

  for(const p of parts){
    const prov = p.provides || {};
    orbitPowerMW += prov.orbitPowerMW || 0;
    radiatorMWth += prov.radiatorMWth || 0;
    if(prov.comms) hasComms = true;
    if(prov.servicing) hasServicing = true;
    if(prov.rackType === "standard") computeLoadMW_std += (prov.computeLoadMW || 0);
    if(prov.rackType === "radhard") computeLoadMW_rh += (prov.computeLoadMW || 0);
  }

  const totalRackLoad = computeLoadMW_std + computeLoadMW_rh;
  const effectiveComputeLoadMW = Math.min(totalRackLoad, orbitPowerMW);

  // Allocate effective load proportionally between rack types.
  let effStd = 0, effRh = 0;
  if(totalRackLoad > 0){
    effStd = effectiveComputeLoadMW * (computeLoadMW_std / totalRackLoad);
    effRh = effectiveComputeLoadMW * (computeLoadMW_rh / totalRackLoad);
  }

  const rawCU = effStd * CONFIG.rules.space.compute.standardEfficiencyCUPerMW +
               effRh * CONFIG.rules.space.compute.radHardEfficiencyCUPerMW;

  const heatLoad = effectiveComputeLoadMW * 0.95;
  const throttle = (heatLoad <= 0) ? 1.0 : Math.min(1.0, radiatorMWth / heatLoad);

  return {
    orbitPowerMW,
    radiatorMWth,
    hasComms,
    hasServicing,
    computeLoadMW_std,
    computeLoadMW_rh,
    effectiveComputeLoadMW,
    rawCU,
    heatLoadMWth: heatLoad,
    throttleFactor: throttle
  };
}

function computeWinProgress(){
  const e = deriveEarth();
  const s = deriveSpace();

  const p1 = clamp(e.usablePowerTW/CONFIG.constants.win.usablePowerTW_min, 0, 1);
  const p2 = clamp(e.reliability/CONFIG.constants.win.reliability_min, 0, 1);
  const p3 = clamp((CONFIG.constants.win.heatStress_max - e.heatStress)/CONFIG.constants.win.heatStress_max, 0, 1);
  const p4 = clamp(s.totalComputeDelivered/CONFIG.constants.win.computeDelivered_min, 0, 1);
  return 0.4*p1 + 0.2*p2 + 0.2*p3 + 0.2*p4;
}

function deriveEarth(extra={}){
  const earth = RUN.state.earth;
  const demandTW = (extra.demandTW ?? earth.demandTW);

  const solarWindMultiplier = (extra.solarWindMultiplier ?? 1.0);
  const solarGen = (extra.solarGenTW ?? earth.solarGenTW);
  const windGen = (extra.windGenTW ?? earth.windGenTW);
  const firmGen = (extra.firmGenTW ?? earth.firmGenTW);

  const generatedTW = firmGen + (solarGen + windGen)*solarWindMultiplier;
  const curtailmentTW = Math.max(0, generatedTW - demandTW - (earth.batteryBlocks*0.6) - (earth.hvSegments*0.3));
  const usablePowerTW = Math.min(generatedTW - curtailmentTW, demandTW);

  const variableGenEvent = (solarGen + windGen)*solarWindMultiplier;
  const variableShare = (generatedTW > 0) ? (variableGenEvent / generatedTW) : 0;

  return {
    demandTW,
    solarWindMultiplier,
    generatedTW,
    curtailmentTW,
    usablePowerTW,
    variableShare
  };
}

function deriveSpace(){
  const sp = RUN.state.space;
  const orbit = sumOrbit();
  return {
    ...orbit,
    lrl: sp.launchReadinessLevel,
    successfulFlights: sp.successfulFlights,
    failedFlights: sp.failedFlights,
    totalComputeDelivered: sp.totalComputeDelivered,
    odcTurnsOperational: sp.odcTurnsOperational,
    odcFailed: sp.odcFailed
  };
}

function currentFailureChance(action){
  let fail = action.baseFailureChance;

  // Build-based mitigation
  for(const m of CONFIG.launchSystem.failureMitigation){
    if(hasBuilt(m.ifBuilt)) fail -= m.failureChanceMinus;
  }

  // Learning curve
  const s = RUN.state.space;
  fail -= CONFIG.launchSystem.learningCurve.minusPerSuccessfulFlight * (s.successfulFlights||0);
  fail += CONFIG.launchSystem.learningCurve.plusPerFailedFlight * (s.failedFlights||0);

  // Breakthrough temp bonus
  fail -= (RUN.state.flags.nextTestFlightFailureMinus || 0);

  fail = clamp(fail, CONFIG.launchSystem.clampFailureChanceMin, CONFIG.launchSystem.clampFailureChanceMax);
  return fail;
}

// ---------- Queue helpers ----------

function queueHas(kind){ return RUN.queue.some(q=>q.kind===kind); }
function queueFind(kind){ return RUN.queue.find(q=>q.kind===kind); }

function queueCost(){
  let total = 0;
  // Research
  const r = queueFind("research");
  if(r){
    const tech = CONFIG.techs.find(t=>t.id===r.techId);
    total += tech?.cost || 0;
  }

  // Earth builds
  for(const q of RUN.queue.filter(q=>q.kind==="earthBuild")){
    const b = CONFIG.earthBuilds.find(x=>x.id===q.buildId);
    if(b){
      total += applyCostModifiers(b.cost, b.id);
    }
  }

  // Test flight
  const tf = queueFind("testFlight");
  if(tf){
    const a = CONFIG.actions.find(a=>a.id===tf.actionId);
    total += a?.flightCost || 0;
  }

  // Payload launch
  const pl = queueFind("payloadLaunch");
  if(pl){
    // parts cost
    for(const pid of pl.partIds){
      const p = CONFIG.orbitParts.find(x=>x.id===pid);
      if(p) total += p.cost;
    }
    // payload launch cost
    total += computePayloadLaunchCost(pl.payloadMass_t);
  }

  return total;
}

function creditsRemaining(){
  return RUN.credits - queueCost();
}
function canAfford(cost){
  return creditsRemaining() >= cost;
}
function formatCredits(n){
  return `C${fmt(n,0)}`;
}
function budgetGuard(requiredCost, label){
  const remaining = creditsRemaining();
  if(remaining >= requiredCost) return true;
  const missing = Math.max(0, requiredCost - remaining);
  toast(`Cannot queue ${label}: need ${formatCredits(requiredCost)}, only ${formatCredits(remaining)} remaining after queued items (short ${formatCredits(missing)}).`);
  return false;
}
function reasonLine(reason){
  return `<span class="r bad">X ${reason}</span>`;
}
function reqLine(label, ok){
  const cls = ok ? "ok" : "bad";
  return `<span class="r ${cls}">${ok ? "OK" : "X"} ${label}</span>`;
}
function computePayloadLaunchCost(payloadMass_t){
  let base = CONFIG.constants.launchEconomics.payloadLaunchBaseCost;
  if(hasBuilt("B_LAUNCH_FACTORY")) base += (CONFIG.constants.launchEconomics.ifBuilt_B_LAUNCH_FACTORY?.payloadLaunchBaseCostDelta || 0);
  const perT = CONFIG.constants.launchEconomics.payloadCostPerTonne;
  return base + perT * payloadMass_t;
}

function undoQueue(){ RUN.queue.pop(); render(); saveRun(); }
function clearQueue(){ RUN.queue = []; render(); saveRun(); }

// ---------- Eligibility ----------

function techAvailable(t){
  if(hasTech(t.id)) return false;
  return t.prereqs.every(hasTech);
}

function buildAvailable(b){
  return hasTech(b.techPrereq);
}

function orbitPartAvailable(p){
  if(!hasTech(p.techPrereq)) return false;
  const lrlReq = p.requiresLRL ?? 0;
  if(lrlReq > 0 && RUN.state.space.launchReadinessLevel < lrlReq) return false;
  // overall gating for racks
  if(p.id.startsWith("P_COMPUTE_RACK") && RUN.state.space.launchReadinessLevel !== 3) return false;
  return true;
}

function canLaunchPayload(){
  return RUN.state.space.launchReadinessLevel >= CONFIG.rules.space.launchGating.canLaunchOrbitPartsIfLRLAtLeast;
}

// ---------- Turn resolution ----------

function endTurn(){
  if(RUN.won || RUN.lost) return;

  const spend = queueCost();
  if(spend > RUN.credits){
    toast("Not enough credits for queued actions.");
    return;
  }

  const prevSnapshot = {
    credits: RUN.credits,
    earthDer: deriveEarth(),
    earth: deepClone(RUN.state.earth),
    spaceDer: deriveSpace(),
    space: deepClone(RUN.state.space)
  };

  // Deduct spend upfront.
  RUN.credits -= spend;

  // Reset per-turn flags.
  RUN.state.space.payloadLaunchedThisTurn = false;
  RUN.state.space.payloadMassThisTurn_t = 0;

  // Decrement cost modifiers duration.
  RUN.state.flags.activeCostModifiers = (RUN.state.flags.activeCostModifiers || []).map(m=>({
    ...m,
    remainingTurns: Math.max(0, (m.remainingTurns||0) - 1)
  })).filter(m=>m.remainingTurns > 0);

  // Decrement test flight cooldown
  RUN.state.space.testFlightCooldownTurns = Math.max(0, (RUN.state.space.testFlightCooldownTurns||0) - 1);

  // Apply queued research (immediate unlock)
  const qResearch = queueFind("research");
  if(qResearch){
    RUN.researched.add(qResearch.techId);
  }

  // Apply queued earth builds (persistently update earth state)
  const builtThisTurn = [];
  for(const q of RUN.queue.filter(q=>q.kind==="earthBuild")){
    const b = CONFIG.earthBuilds.find(x=>x.id===q.buildId);
    if(!b) continue;
    // Count
    RUN.state.earth.builtCounts[b.id] = (RUN.state.earth.builtCounts[b.id] || 0) + 1;
    // Apply deltas
    const d = b.deltas || {};
    for(const k of Object.keys(d)){
      RUN.state.earth[k] = (RUN.state.earth[k] ?? 0) + d[k];
    }
    builtThisTurn.push(b.id);
  }

  // Apply queued payload manifest cost modifiers already accounted for; add to state in launch resolution.
  const qPayload = queueFind("payloadLaunch");
  const qTestFlight = queueFind("testFlight");

  // Roll event
  const event = weightedPick(CONFIG.events);
  RUN.lastEvent = event;

  // Apply event modifiers (store locals)
  let demandShock = 0;
  let solarWindMultiplier = 1.0;
  let reliabilityShock = 0;
  let eventCreditsDelta = 0;

  let launchFailure = false;
  let radiationStorm = false;

  const mod = event.modifiers || {};
  if(mod.demandShockTW) demandShock += mod.demandShockTW;
  if(mod.solarWindMultiplier) solarWindMultiplier *= mod.solarWindMultiplier;
  if(mod.reliabilityShock) reliabilityShock += mod.reliabilityShock;
  if(mod.creditsDelta) eventCreditsDelta += mod.creditsDelta;
  if(mod.nextTestFlightFailureMinus) RUN.state.flags.nextTestFlightFailureMinus = mod.nextTestFlightFailureMinus;
  if(mod.launchFailure) launchFailure = true;
  if(mod.radiationStorm) radiationStorm = true;

  // Conditional nuclear backlash
  if(mod.conditionalIfHasTag === "nuclear"){
    if(!hasBuilt("B_NUCLEAR")){
      // if no nuclear built, ignore this event's nuclear-specific reliability shock and cost modifier
      reliabilityShock = 0;
      // don't apply buildCostModifier
      if(mod.buildCostModifier){ /* ignore */ }
    }
  }

  // Apply build cost modifier from event
  if(mod.buildCostModifier && (mod.conditionalIfHasTag !== "nuclear" || hasBuilt("B_NUCLEAR"))){
    RUN.state.flags.activeCostModifiers.push({
      targetBuildId: mod.buildCostModifier.targetBuildId,
      addCost: mod.buildCostModifier.addCost,
      remainingTurns: mod.buildCostModifier.durationTurns
    });
  }

  // Apply mitigations
  const mitig = event.mitigations || {};
  const earth = RUN.state.earth;

  if(mitig.demandResponseHalvesDemandShock && earth.demandResponsePrograms > 0){
    demandShock *= 0.5;
  }

  if(mitig.hvSegmentsMultiplyReliabilityShock){
    reliabilityShock *= Math.pow(mitig.hvSegmentsMultiplyReliabilityShock, earth.hvSegments);
  }else{
    // default mitigation rule for HV segments
    reliabilityShock *= Math.pow(CONFIG.rules.earth.eventMitigation.hvSegmentsMultiplyReliabilityShockPerSegment, earth.hvSegments);
  }

  if(mitig.batteriesReduceReliabilityShockMultiplier && earth.batteryBlocks > 0){
    reliabilityShock *= mitig.batteriesReduceReliabilityShockMultiplier;
  }

  if(mitig.demandResponseReducesReliabilityShockMultiplier && earth.demandResponsePrograms > 0){
    reliabilityShock *= mitig.demandResponseReducesReliabilityShockMultiplier;
  }

  // ---------- Resolve Earth ----------

  // Demand
  const demandTW = earth.demandTW + demandShock;

  // Generation with multiplier applied to solar+wind
  const derivedEarth = deriveEarth({ demandTW, solarWindMultiplier });

  // Reliability update
  let reliability = earth.reliability + reliabilityShock;

  // Variability penalty
  const variableShare = derivedEarth.variableShare;
  if(variableShare > CONFIG.rules.earth.variabilityPenaltyRule.ifVariableShareGreaterThan &&
     earth.batteryBlocks < CONFIG.rules.earth.variabilityPenaltyRule.andBatteryBlocksLessThan &&
     earth.hvSegments < CONFIG.rules.earth.variabilityPenaltyRule.andHVSegmentsLessThan){
    reliability -= CONFIG.rules.earth.variabilityPenaltyRule.thenReliabilityMinus;
  }

  reliability = clamp(reliability, CONFIG.rules.earth.reliabilityClamp.min, CONFIG.rules.earth.reliabilityClamp.max);
  earth.reliability = reliability;

  // Heat stress
  let heat = earth.heatStress;
  heat += (derivedEarth.usablePowerTW - 20) * CONFIG.rules.earth.heatStressUpdate.add_perTWAbove20;
  heat += earth.emissionsIndex * CONFIG.rules.earth.heatStressUpdate.add_emissionsIndexMultiplier;
  heat -= earth.hvSegments * CONFIG.rules.earth.heatStressUpdate.subtract_hvSegment;
  heat -= earth.batteryBlocks * CONFIG.rules.earth.heatStressUpdate.subtract_batteryBlock;
  heat -= earth.hydrogenPlants * CONFIG.rules.earth.heatStressUpdate.subtract_hydrogenPlant;
  heat = clamp(heat, CONFIG.rules.earth.heatStressUpdate.clampMin, CONFIG.rules.earth.heatStressUpdate.clampMax);
  earth.heatStress = heat;

  // Clamp emissions
  earth.emissionsIndex = clamp(earth.emissionsIndex, CONFIG.rules.earth.emissionsClamp.min, CONFIG.rules.earth.emissionsClamp.max);

  // Update demand (persist baseline demand includes electrification builds already applied) - keep demandTW baseline as built.
  // Derived demand with event is not persisted.

  // ---------- Resolve Test Flight ----------
  let testFlightResult = null;
  if(qTestFlight){
    const action = CONFIG.actions.find(a=>a.id===qTestFlight.actionId);
    if(action){
      if(RUN.state.space.testFlightCooldownTurns > 0){
        testFlightResult = { actionId: action.id, ok: false, reason: "Cooldown" };
      } else {
        const failChance = currentFailureChance(action);
        const roll = Math.random()*100;
        const failed = roll < failChance;

        if(failed){
          RUN.credits += (action.onFail?.creditsDelta || 0);
          earth.heatStress = clamp(earth.heatStress + (action.onFail?.heatStressDelta || 0), 0, 120);
          RUN.state.space.failedFlights = (RUN.state.space.failedFlights||0) + 1;
          RUN.state.space.testFlightCooldownTurns = action.onFail?.cooldownTurns || 0;
          testFlightResult = { actionId: action.id, ok: false, failChance, roll };
        } else {
          RUN.state.space.successfulFlights = (RUN.state.space.successfulFlights||0) + 1;
          RUN.state.space.launchReadinessLevel = Math.max(RUN.state.space.launchReadinessLevel, action.setsLRLToAtLeastOnSuccess || 0);
          testFlightResult = { actionId: action.id, ok: true, failChance, roll };
        }

        // Breakthrough bonus is one-shot
        RUN.state.flags.nextTestFlightFailureMinus = 0;
      }
    }
  }

  // ---------- Resolve Payload Launch ----------
  let payloadResult = null;
  if(qPayload){
    if(!canLaunchPayload()){
      payloadResult = { ok:false, reason:"LRL too low" };
    } else {
      RUN.state.space.payloadLaunchedThisTurn = true;
      RUN.state.space.payloadMassThisTurn_t = qPayload.payloadMass_t;

      // Apply launch failure event effect to manifest (lose parts totaling 20t, or 5t if already have servicing in orbit)
      let manifestIds = [...qPayload.partIds];
      if(launchFailure && manifestIds.length){
        const orbit = sumOrbit();
        const lossTarget = orbit.hasServicing ? 5 : 20;
        let lostMass = 0;
        // random shuffle manifest
        manifestIds = manifestIds.sort(()=>Math.random()-0.5);
        const kept = [];
        const lost = [];
        for(const id of manifestIds){
          const part = CONFIG.orbitParts.find(p=>p.id===id);
          const m = part?.mass_t || 0;
          if(lostMass < lossTarget){
            lost.push(id);
            lostMass += m;
          } else {
            kept.push(id);
          }
        }
        manifestIds = kept;
        payloadResult = { ok:true, launchFailure:true, lostParts: lost, keptParts: kept };
      } else {
        payloadResult = { ok:true, launchFailure:false, keptParts: manifestIds, lostParts: [] };
      }

      // Add kept parts into orbit
      for(const id of (payloadResult.keptParts||[])){
        const part = CONFIG.orbitParts.find(p=>p.id===id);
        if(part){
          RUN.state.space.orbitParts.push(deepClone(part));
          RUN.state.space.orbitMass_t += part.mass_t;
        }
      }
    }
  }

  // ---------- Resolve Orbit Compute ----------
  const orbit = sumOrbit();
  const odcActive = orbit.effectiveComputeLoadMW > 0;

  let uptime = 0;
  let deliveredCU = 0;
  let throttleFactor = orbit.throttleFactor;
  const thermalDanger = throttleFactor < CONFIG.rules.space.thermal.thermalDangerIfThrottleBelow;

  if(odcActive){
    // Base uptime weighted by rack load proportions
    const totalRackLoad = orbit.computeLoadMW_std + orbit.computeLoadMW_rh;
    const wStd = totalRackLoad > 0 ? orbit.computeLoadMW_std/totalRackLoad : 0;
    const wRh = 1 - wStd;
    uptime = wStd*CONFIG.rules.space.uptime.baseStandard + wRh*CONFIG.rules.space.uptime.baseRadHard;

    if(orbit.hasServicing) uptime += CONFIG.rules.space.uptime.servicingBonus;

    if(radiationStorm){
      // Apply penalty; rad-hard racks soften it (we approximate by halving penalty on rh portion)
      let penalty = CONFIG.rules.space.uptime.radiationStormPenalty;
      // servicing reduces penalty
      if(orbit.hasServicing) penalty *= CONFIG.rules.space.uptime.servicingReducesRadiationPenaltyMultiplier;

      const effectivePenalty = wStd*penalty + wRh*(penalty*0.5);
      uptime -= effectivePenalty;
    }

    if(thermalDanger) uptime -= CONFIG.rules.space.uptime.thermalDangerPenalty;

    uptime = clamp(uptime, CONFIG.rules.space.uptime.clampMin, CONFIG.rules.space.uptime.clampMax);

    deliveredCU = orbit.rawCU * throttleFactor * (uptime/100);

    RUN.state.space.totalComputeDelivered += deliveredCU;

    if(uptime >= CONFIG.rules.space.operationalTurnDefinition.countsAsOperationalIfUptimeAtLeast && deliveredCU > 0){
      RUN.state.space.odcTurnsOperational += 1;
    }

    // Catastrophic failure check
    if(!RUN.state.space.odcFailed){
      let threshold = null;
      // choose lowest rollAtLeast among applicable (highest failure chance)
      const checks = CONFIG.rules.space.catastrophicFailure.thresholds;

      const hasStandard = orbit.computeLoadMW_std > 0;

      for(const c of checks){
        let applies = false;
        if(c.condition === "thermalDanger" && thermalDanger) applies = true;
        if(c.condition === "radiationStorm_and_hasStandardRacks" && radiationStorm && hasStandard) applies = true;
        if(c.condition === "payloadLaunchedThisTurn_and_noServicing" && RUN.state.space.payloadLaunchedThisTurn && !orbit.hasServicing) applies = true;

        if(applies){
          if(threshold === null) threshold = c.failIfRollAtLeast;
          else threshold = Math.min(threshold, c.failIfRollAtLeast);
        }
      }

      if(threshold !== null){
        const roll = Math.floor(Math.random()*100) + 1;
        if(roll >= threshold){
          // Remove random orbit part
          if(RUN.state.space.orbitParts.length){
            const idx = Math.floor(Math.random()*RUN.state.space.orbitParts.length);
            const removed = RUN.state.space.orbitParts.splice(idx,1)[0];
            RUN.state.space.orbitMass_t = Math.max(0, RUN.state.space.orbitMass_t - (removed.mass_t||0));
          }
          RUN.state.space.odcFailed = true;

          if(RUN.state.space.totalComputeDelivered < CONFIG.constants.win.computeDelivered_min){
            RUN.lost = true;
            RUN.lossReason = "Catastrophic ODC failure before meeting compute target.";
          }
        }
      }
    }
  }

  // ---------- Income ----------
  const usableTW = derivedEarth.usablePowerTW;
  let income = CONFIG.constants.income.base;
  income += Math.min(CONFIG.constants.income.powerBonusCap, Math.max(0, usableTW - 20) * CONFIG.constants.income.powerBonusPerTWAbove20);
  if(earth.reliability >= 99) income += CONFIG.constants.income.reliabilityBonusIfAtLeast99;
  if(earth.reliability < 95) income += CONFIG.constants.income.blackoutPenaltyIfBelow95;

  RUN.credits += income;
  RUN.credits += eventCreditsDelta;

  // ---------- Lose streak tracking ----------
  if(earth.reliability < 92){
    RUN.state.flags.reliabilityBelow92Streak += 1;
  } else {
    RUN.state.flags.reliabilityBelow92Streak = 0;
  }

  // ---------- Win/Lose checks ----------
  if(!RUN.lost){
    if(earth.heatStress >= CONFIG.constants.lose.heatStress_atLeast){
      RUN.lost = true;
      RUN.lossReason = "Heat Stress exceeded safe limits.";
    } else if(RUN.state.flags.reliabilityBelow92Streak >= CONFIG.constants.lose.reliabilityBelow92_consecutiveTurns){
      RUN.lost = true;
      RUN.lossReason = "Reliability collapse (below 92% for too long).";
    }
  }

  if(!RUN.lost){
    const won =
      usableTW >= CONFIG.constants.win.usablePowerTW_min &&
      earth.reliability >= CONFIG.constants.win.reliability_min &&
      earth.heatStress <= CONFIG.constants.win.heatStress_max &&
      RUN.state.space.odcTurnsOperational >= CONFIG.constants.win.odcTurnsOperational_min &&
      RUN.state.space.totalComputeDelivered >= CONFIG.constants.win.computeDelivered_min;

    if(won){
      RUN.won = true;
    }
  }

  // turn limit
  if(!RUN.won && !RUN.lost && RUN.turn >= CONFIG.constants.turnLimit){
    RUN.lost = true;
    RUN.lossReason = "Ran out of time.";
  }

  // ---------- Report ----------
  RUN.lastReport = {
    turn: RUN.turn,
    event: event.name,
    eventId: event.id,
    builtThisTurn,
    researchThisTurn: qResearch?.techId || null,
    testFlightResult,
    payloadResult,
    earth: {
      demandTW,
      solarWindMultiplier,
      generatedTW: derivedEarth.generatedTW,
      curtailmentTW: derivedEarth.curtailmentTW,
      usablePowerTW: derivedEarth.usablePowerTW,
      reliability: earth.reliability,
      emissionsIndex: earth.emissionsIndex,
      heatStress: earth.heatStress
    },
    space: {
      lrl: RUN.state.space.launchReadinessLevel,
      orbitPowerMW: orbit.orbitPowerMW,
      radiatorMWth: orbit.radiatorMWth,
      effectiveComputeLoadMW: orbit.effectiveComputeLoadMW,
      throttleFactor,
      uptime,
      deliveredCU,
      totalComputeDelivered: RUN.state.space.totalComputeDelivered,
      odcTurnsOperational: RUN.state.space.odcTurnsOperational,
      odcFailed: RUN.state.space.odcFailed
    },
    finances: {
      spent: spend,
      income,
      eventCreditsDelta,
      endCredits: RUN.credits
    }
  };

  const nextEarth = deriveEarth();
  const nextSpace = deriveSpace();
  const deltaUsablePower = nextEarth.usablePowerTW - prevSnapshot.earthDer.usablePowerTW;
  const deltaReliability = RUN.state.earth.reliability - prevSnapshot.earth.reliability;
  const deltaHeatStress = RUN.state.earth.heatStress - prevSnapshot.earth.heatStress;
  const deltaCredits = RUN.credits - prevSnapshot.credits;
  const deltaLRL = RUN.state.space.launchReadinessLevel - prevSnapshot.space.launchReadinessLevel;
  const deltaCompute = RUN.state.space.totalComputeDelivered - prevSnapshot.space.totalComputeDelivered;

  RUN.lastSummary = {
    headline: `Turn ${RUN.turn} Summary`,
    sub: `${event.name}${RUN.won ? "  |  Victory achieved" : RUN.lost ? "  |  Run ended" : ""}`,
    deltas: [
      { label:"Usable Power", value:`${deltaUsablePower >= 0 ? "+" : ""}${fmt(deltaUsablePower,1)} TW` },
      { label:"Reliability", value:`${deltaReliability >= 0 ? "+" : ""}${fmt(deltaReliability,1)}%` },
      { label:"Heat Stress", value:`${deltaHeatStress >= 0 ? "+" : ""}${fmt(deltaHeatStress,1)}` },
      { label:"Credits", value:`${deltaCredits >= 0 ? "+" : ""}${formatCredits(deltaCredits)}` },
      { label:"LRL", value:`${deltaLRL >= 0 ? "+" : ""}${fmt(deltaLRL,0)}` },
      { label:"Compute Delivered", value:`${deltaCompute >= 0 ? "+" : ""}${fmt(deltaCompute,1)} CU` }
    ]
  };

  // Clear queue
  RUN.queue = [];

  // Advance turn
  RUN.turn += 1;

  render();
  saveRun();

  if(RUN.won){ toast("You win! You built a stable Type I-ish grid and an operational orbital data center."); }
  if(RUN.lost){ toast(`Run ended: ${RUN.lossReason}`); }
}

// ---------- UI rendering ----------

function toast(msg){
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(()=>{ el.classList.add("show"); }, 10);
  setTimeout(()=>{ el.classList.remove("show"); }, 2800);
  setTimeout(()=>{ el.remove(); }, 3200);
}

function showModal(title, html){
  $("#modal-title").textContent = title;
  $("#modal-body").innerHTML = html;
  const m = $("#modal");
  m.setAttribute("aria-hidden", "false");
}

function hideModal(){
  $("#modal").setAttribute("aria-hidden", "true");
}

function render(){
  $("#subtitle").textContent = `Turn ${Math.min(RUN.turn, CONFIG.constants.turnLimit)} / ${CONFIG.constants.turnLimit}`;

  renderDashboard();
  renderActionBar();
  renderSummaryBanner();

  renderEarthTab();
  renderSpaceTab();
  renderTechTab();
  renderReportsTab();
}


function renderSummaryBanner(){
  const el = $("#summary");
  if(!el) return;
  const s = RUN.lastSummary;
  if(!s){
    el.innerHTML = "";
    return;
  }
  const deltas = (s.deltas||[]).map(d=>{
    const cls = d.value.startsWith("+") ? "pos" : (d.value.startsWith("-") ? "neg" : "");
    return `<span class="delta ${cls}">${d.label}: ${d.value}</span>`;
  }).join("");
  el.innerHTML = `
    <div class="summary-card">
      <div class="headline">${s.headline}</div>
      <div class="muted">${s.sub || ""}</div>
      <div style="height:8px"></div>
      <div class="delta-row">${deltas}</div>
    </div>
  `;
}
function renderDashboard(){
  const earthDer = deriveEarth();
  const earth = RUN.state.earth;
  const space = deriveSpace();

  const conditions = [
    earthDer.usablePowerTW >= CONFIG.constants.win.usablePowerTW_min,
    earth.reliability >= CONFIG.constants.win.reliability_min,
    earth.heatStress <= CONFIG.constants.win.heatStress_max,
    space.odcTurnsOperational >= CONFIG.constants.win.odcTurnsOperational_min,
    space.totalComputeDelivered >= CONFIG.constants.win.computeDelivered_min
  ];
  const done = conditions.filter(Boolean).length;

  const prog = Math.round(computeWinProgress()*100);


  const milestones = [
    { id:"m_lrl1", label:"LRL 1: Suborbital proven", ok: RUN.state.space.launchReadinessLevel >= 1 },
    { id:"m_lrl2", label:"LRL 2: Orbital demo", ok: RUN.state.space.launchReadinessLevel >= 2 },
    { id:"m_orbit_core", label:"Orbit core: Solar + Radiators", ok: (deriveSpace().orbitPowerMW >= 50) && (deriveSpace().radiatorMWth >= 80) },
    { id:"m_lrl3", label:"LRL 3: Operational reliability", ok: RUN.state.space.launchReadinessLevel >= 3 },
    { id:"m_compute", label:`Compute delivered: ${Math.floor(deriveSpace().totalComputeDelivered)} / ${CONFIG.constants.win.computeDelivered_min} CU`, ok: deriveSpace().totalComputeDelivered >= CONFIG.constants.win.computeDelivered_min }
  ];
  const milestonesHtml = `
    <div class="card milestones">
      <div class="card-title">Next Milestones</div>
      <div class="card-subtitle">Tiny guide rails so it feels like a game, not a spreadsheet.</div>
      <div style="height:6px"></div>
      ${milestones.map(m=>`<div class="m ${m.ok?"done":""}"><div class="box">${m.ok?"OK":""}</div><div class="txt">${m.label}</div></div>`).join("")}
    </div>
  `;

  const html = `
    <div class="kpi-grid">
      <div class="kpi">
        <div class="label">Credits</div>
        <div class="value mono">C${fmt(RUN.credits,0)}</div>
      </div>
      <div class="kpi">
        <div class="label">Win Progress</div>
        <div class="value mono">${prog}%</div>
        <div class="progress"><div class="progress-bar" style="width:${prog}%"></div></div>
      </div>
      <div class="kpi">
        <div class="label">Win Checklist</div>
        <div class="value mono">${done}/5</div>
      </div>
    </div>

    <div class="section-title">Earth</div>
    <div class="kpi-grid">
      <div class="kpi">
        <div class="label">Usable Power</div>
        <div class="value mono">${fmt(earthDer.usablePowerTW,1)} TW</div>
        <div class="hint">Target ${CONFIG.constants.win.usablePowerTW_min}</div>
      </div>
      <div class="kpi">
        <div class="label">Reliability</div>
        <div class="value mono">${fmt(earth.reliability,1)}%</div>
        <div class="hint">Target ${CONFIG.constants.win.reliability_min}%</div>
      </div>
      <div class="kpi">
        <div class="label">Heat Stress</div>
        <div class="value mono">${fmt(earth.heatStress,0)}</div>
        <div class="hint">Max ${CONFIG.constants.win.heatStress_max} (lose at ${CONFIG.constants.lose.heatStress_atLeast})</div>
      </div>
      <div class="kpi">
        <div class="label">Emissions</div>
        <div class="value mono">${fmt(earth.emissionsIndex,0)}</div>
        <div class="hint">Index (0-100)</div>
      </div>
    </div>

    <div class="section-title">Space</div>
    <div class="kpi-grid">
      <div class="kpi">
        <div class="label">LRL</div>
        <div class="value mono">${space.lrl}</div>
        <div class="hint">0-3 (3 to deploy compute racks)</div>
      </div>
      <div class="kpi">
        <div class="label">Orbit Power</div>
        <div class="value mono">${fmt(space.orbitPowerMW,0)} MW</div>
      </div>
      <div class="kpi">
        <div class="label">Radiators</div>
        <div class="value mono">${fmt(space.radiatorMWth,0)} MWth</div>
      </div>
      <div class="kpi">
        <div class="label">Compute</div>
        <div class="value mono">${fmt(space.totalComputeDelivered,0)} / ${CONFIG.constants.win.computeDelivered_min} CU</div>
        <div class="hint">ODC turns ${space.odcTurnsOperational}/${CONFIG.constants.win.odcTurnsOperational_min}</div>
      </div>
    </div>

    ${RUN.won ? `<div class="alert good">OK You win. (New Run to play again.)</div>` : ""}
    ${RUN.lost ? `<div class="alert bad">FAIL Run ended: ${RUN.lossReason}</div>` : ""}
  ` + milestonesHtml;

  $("#dashboard").innerHTML = html;
}

function renderActionBar(){
  const spend = queueCost();
  const earthDer = deriveEarth();
  const earth = RUN.state.earth;

  // naive projected income
  let income = CONFIG.constants.income.base;
  income += Math.min(CONFIG.constants.income.powerBonusCap, Math.max(0, earthDer.usablePowerTW - 20) * CONFIG.constants.income.powerBonusPerTWAbove20);
  if(earth.reliability >= 99) income += CONFIG.constants.income.reliabilityBonusIfAtLeast99;
  if(earth.reliability < 95) income += CONFIG.constants.income.blackoutPenaltyIfBelow95;

  const projected = RUN.credits - spend + income;

  const payload = queueFind("payloadLaunch");
  const payloadMass = payload ? payload.payloadMass_t : 0;
  const payloadCost = payload ? computePayloadLaunchCost(payloadMass) : 0;

  const risk = [];
  if(projected < 0) risk.push({txt:"Insufficient credits", cls:"bad"});
  if(earth.reliability < 95) risk.push({txt:"Blackout penalty risk", cls:"warn"});
  const orbit = sumOrbit();
  if(orbit.throttleFactor < 0.7 && orbit.effectiveComputeLoadMW > 0) risk.push({txt:"Thermal danger in orbit", cls:"warn"});
  if(RUN.state.space.testFlightCooldownTurns > 0) risk.push({txt:`Test flight cooldown ${RUN.state.space.testFlightCooldownTurns}`, cls:"muted"});

  const html = `
    <div class="actionbar-left">
      <button class="btn btn-primary" id="btn-end" ${RUN.won||RUN.lost?"disabled":""}>End Turn</button>
      <button class="btn btn-ghost" id="btn-undo" ${RUN.queue.length?"":"disabled"}>Undo last</button>
      <button class="btn btn-ghost" id="btn-clear" ${RUN.queue.length?"":"disabled"}>Clear</button>
    </div>

    <div class="actionbar-mid">
      <div class="mono">Queued spend: C${fmt(spend,0)}  |  Projected after income: C${fmt(projected,0)}</div>
      ${payload ? `<div class="mono small">Payload: ${fmt(payloadMass,0)} t  |  Payload launch cost: C${fmt(payloadCost,0)}</div>` : `<div class="mono small muted">Queue builds/research/test flight/payload, then End Turn.</div>`}
    </div>

    <div class="actionbar-right">
      ${risk.map(r=>`<span class="chip ${r.cls}">${r.txt}</span>`).join(" ")}
    </div>
  `;

  $("#actionbar").innerHTML = html;

  $("#btn-end")?.addEventListener("click", endTurn);
  $("#btn-undo")?.addEventListener("click", ()=>{ undoQueue(); });
  $("#btn-clear")?.addEventListener("click", ()=>{ clearQueue(); });
}

function renderEarthTab(){
  const earth = RUN.state.earth;
  const der = deriveEarth();

  const mixHtml = `
    <div class="card">
      <div class="card-header">
        <div>
          <div class="card-title">Energy System Snapshot</div>
          <div class="card-subtitle">Demand vs generation, curtailment, and variability.</div>
        </div>
      </div>
      <div class="grid-2">
        <div class="kpi">
          <div class="label">Demand</div>
          <div class="value mono">${fmt(earth.demandTW,1)} TW</div>
        </div>
        <div class="kpi">
          <div class="label">Generated (typical)</div>
          <div class="value mono">${fmt(earth.firmGenTW + earth.solarGenTW + earth.windGenTW,1)} TW</div>
        </div>
        <div class="kpi">
          <div class="label">Curtailment (typical)</div>
          <div class="value mono">${fmt(der.curtailmentTW,1)} TW</div>
          <div class="hint">Storage absorbs ${fmt(earth.batteryBlocks*0.6,1)} TW  |  Grid bonus ${fmt(earth.hvSegments*0.3,1)} TW</div>
        </div>
        <div class="kpi">
          <div class="label">Variable share</div>
          <div class="value mono">${fmt(der.variableShare*100,0)}%</div>
          <div class="hint">Penalty risk if >50% without storage/grid</div>
        </div>
        <div class="kpi">
          <div class="label">Storage blocks</div>
          <div class="value mono">${earth.batteryBlocks}</div>
        </div>
        <div class="kpi">
          <div class="label">HV segments</div>
          <div class="value mono">${earth.hvSegments}</div>
        </div>
      </div>
    </div>
  `;

  const builds = CONFIG.earthBuilds.map(b=>{
    const available = buildAvailable(b);
    const cost = applyCostModifiers(b.cost, b.id);
    const count = getBuildCount(b.id);
    const reasons = [];
    if(!available) reasons.push(`Requires tech: ${b.techPrereq}`);
    if(!canAfford(cost)) reasons.push(`Insufficient credits: need ${formatCredits(cost)}, remaining ${formatCredits(creditsRemaining())}`);

    const effects = [];
    const d = b.deltas || {};
    if(d.solarGenTW) effects.push(`+${fmt(d.solarGenTW,1)} TW solar`);
    if(d.windGenTW) effects.push(`+${fmt(d.windGenTW,1)} TW wind`);
    if(d.firmGenTW) effects.push(`+${fmt(d.firmGenTW,1)} TW firm`);
    if(d.demandTW) effects.push(`+${fmt(d.demandTW,1)} TW demand`);
    if(d.reliability) effects.push(`${d.reliability>0?"+":""}${fmt(d.reliability,1)}% rel`);
    if(d.emissionsIndex) effects.push(`${d.emissionsIndex>0?"+":""}${fmt(d.emissionsIndex,0)} emissions`);
    if(d.heatStress) effects.push(`${d.heatStress>0?"+":""}${fmt(d.heatStress,1)} heat`);
    if(d.batteryBlocks) effects.push(`+${d.batteryBlocks} battery`);
    if(d.hvSegments) effects.push(`+${d.hvSegments} HV`);
    if(d.hydrogenPlants) effects.push(`+${d.hydrogenPlants} H2`);
    if(d.demandResponsePrograms) effects.push(`+${d.demandResponsePrograms} DR`);

    const canQueue = (reasons.length===0) && !RUN.won && !RUN.lost;

    return `
      <div class="card">
        <div class="card-header">
          <div>
            <div class="card-title">${b.name} <span class="chip muted">Owned: ${count}</span></div>
            <div class="card-subtitle">${effects.join("  |  ") || "--"}</div>
          </div>
          <div class="right">
            <div class="mono">${formatCredits(cost)}</div>
            <div class="hint">${reasons.length?reasons[0]:""}</div>
          </div>
        </div>
        <div class="card-body">
          <button class="btn btn-primary" data-build="${b.id}" ${canQueue?"":"disabled"} title="${reasons.join(" | ")}">Queue build</button>
          <button class="btn btn-ghost" data-build-info="${b.id}">Info</button>
          ${reasons.length?`<div class="req">${reasons.map(reasonLine).join("")}</div>`:""}
        </div>
      </div>
    `;
  }).join("");

  $("#panel-earth").innerHTML = `
    <div class="grid">
      ${mixHtml}
      <div class="section-title">Earth Projects</div>
      <div class="grid cards">${builds}</div>
    </div>
  `;

  $$('[data-build]').forEach(btn=>btn.addEventListener('click', (e)=>{
    const id = e.currentTarget.getAttribute('data-build');
    const b = CONFIG.earthBuilds.find(x=>x.id===id);
    if(!b) return;
    if(!buildAvailable(b)){
      toast(`Locked: requires tech ${b.techPrereq}`);
      return;
    }
    const cost = applyCostModifiers(b.cost, b.id);
    if(!budgetGuard(cost, b.name)){
      return;
    }
    RUN.queue.push({ kind:"earthBuild", buildId:id });
    render(); saveRun();
  }));

  $$('[data-build-info]').forEach(btn=>btn.addEventListener('click', (e)=>{
    const id = e.currentTarget.getAttribute('data-build-info');
    const b = CONFIG.earthBuilds.find(x=>x.id===id);
    if(!b) return;
    const d = b.deltas || {};
    const lines = Object.entries(d).map(([k,v])=>`<tr><td class="mono">${k}</td><td class="mono">${v}</td></tr>`).join("");
    showModal(b.name, `
      <div class="muted">Tech prereq: <span class="mono">${b.techPrereq}</span></div>
      <hr>
      <table class="table"><thead><tr><th>Delta</th><th>Value</th></tr></thead><tbody>${lines || ""}</tbody></table>
      <hr>
      <div class="muted">Tip: variable generation (solar/wind) can hurt reliability without storage + HV grid.</div>
    `);
  }));
}

function renderTechTab(){
  const techCards = CONFIG.techs.map(t=>{
    const isRes = hasTech(t.id);
    const avail = techAvailable(t);
    const prereq = t.prereqs.length ? `Prereqs: ${t.prereqs.join(", ")}` : "Prereqs: --";
    const unlocks = t.unlocks?.length ? t.unlocks.join(", ") : "--";
    const reasons = [];
    if(isRes) reasons.push("Already researched");
    if(!avail) reasons.push(`Missing prereqs: ${t.prereqs.filter(p=>!hasTech(p)).join(", ")}`);
    if(queueHas("research")) reasons.push("One research per turn");
    if(!canAfford(t.cost)) reasons.push(`Insufficient credits: need ${formatCredits(t.cost)}, remaining ${formatCredits(creditsRemaining())}`);
    const canQueue = (reasons.length===0) && !RUN.won && !RUN.lost;

    return `
      <div class="card">
        <div class="card-header">
          <div>
            <div class="card-title">${t.name} ${isRes?'<span class="chip good">Researched</span>':(avail?'<span class="chip good">Available</span>':'<span class="chip muted">Locked</span>')}</div>
            <div class="card-subtitle"><span class="mono">${t.id}</span>  |  ${formatCredits(t.cost)}</div>
          </div>
        </div>
        <div class="card-body">
          <div class="muted small">${prereq}</div>
          <div class="muted small">Unlocks: ${unlocks}</div>
          <div style="margin-top:10px">
            <button class="btn btn-primary" data-tech="${t.id}" ${canQueue?"":"disabled"} title="${reasons.join(" | ")}">Queue research</button>
            <button class="btn btn-ghost" data-tech-info="${t.id}">Info</button>
            ${reasons.length?`<div class="req">${reasons.map(reasonLine).join("")}</div>`:""}
          </div>
        </div>
      </div>
    `;
  }).join("");

  $("#panel-tech").innerHTML = `
    <div class="grid">
      <div class="card">
        <div class="card-header">
          <div>
            <div class="card-title">Research</div>
            <div class="card-subtitle">Queue at most 1 tech per turn. Research applies immediately for eligibility.</div>
          </div>
        </div>
        <div class="card-body">
          <div class="muted">Queued: <span class="mono">${queueFind("research")?.techId || "--"}</span></div>
        </div>
      </div>
      <div class="section-title">Tech Tree</div>
      <div class="grid cards">${techCards}</div>
    </div>
  `;

  $$('[data-tech]').forEach(btn=>btn.addEventListener('click', (e)=>{
    const id = e.currentTarget.getAttribute('data-tech');
    const t = CONFIG.techs.find(x=>x.id===id);
    if(!t) return;
    if(queueHas("research")){
      toast("One research per turn.");
      return;
    }
    if(hasTech(id)){
      toast("Already researched.");
      return;
    }
    if(!techAvailable(t)){
      const miss = (t.prereqs||[]).filter(p=>!hasTech(p));
      toast(`Locked: missing prereqs ${miss.join(", ")||"--"}`);
      return;
    }
    if(!budgetGuard(t.cost, t.name)){
      return;
    }
    RUN.queue.push({ kind:"research", techId:id });
    render(); saveRun();
  }));

  $$('[data-tech-info]').forEach(btn=>btn.addEventListener('click', (e)=>{
    const id = e.currentTarget.getAttribute('data-tech-info');
    const t = CONFIG.techs.find(x=>x.id===id);
    if(!t) return;
    showModal(t.name, `
      <div class="muted">Cost: <span class="mono">C${fmt(t.cost,0)}</span></div>
      <div class="muted">Prereqs: <span class="mono">${t.prereqs.join(", ") || "--"}</span></div>
      <hr>
      <div class="muted">Unlocks:</div>
      <div class="mono">${(t.unlocks||[]).join("<br>") || "--"}</div>
    `);
  }));
}

function renderSpaceTab(){
  const sp = RUN.state.space;
  const orbit = sumOrbit();

  const launchAssets = [
    { id:"B_LAUNCH_SITE", name:"Launch Site" },
    { id:"B_ENGINE_AVIONICS", name:"Engine & Avionics" },
    { id:"B_LAUNCH_FACTORY", name:"Manufacturing Line" }
  ];

  const launchAssetsHtml = launchAssets.map(a=>{
    const owned = hasBuilt(a.id);
    return `<span class="chip ${owned?"good":"muted"}">${owned?"OK":"--"} ${a.name}</span>`;
  }).join(" ");

  const testFlightHtml = CONFIG.actions.map(a=>{
    const reqTechOk = a.requiresTech ? hasTech(a.requiresTech) : true;
    const reqBuildOk = (a.requires||[]).every(hasBuilt);
    const lrlOk = sp.launchReadinessLevel >= (a.minLRL||0);
    const cooldownOk = sp.testFlightCooldownTurns === 0;

    const reasons = [];
    if(a.requiresTech && !reqTechOk) reasons.push(`Requires tech: ${a.requiresTech}`);
    for(const b of (a.requires||[])) if(!hasBuilt(b)) reasons.push(`Requires: ${b}`);
    if(!lrlOk) reasons.push(`Requires LRL >= ${a.minLRL}`);
    if(!cooldownOk) reasons.push(`Cooldown: ${sp.testFlightCooldownTurns} turn(s)`);
    if(queueHas("testFlight")) reasons.push("One test flight per turn");
    if(!canAfford(a.flightCost)) reasons.push(`Insufficient credits: need ${formatCredits(a.flightCost)}, remaining ${formatCredits(creditsRemaining())}`);

    const enabled = (reasons.length===0) && !RUN.won && !RUN.lost;

    const fail = currentFailureChance(a);

    return `
      <div class="card">
        <div class="card-header">
          <div>
            <div class="card-title">${a.name}</div>
            <div class="card-subtitle">Cost ${formatCredits(a.flightCost)}  |  Failure chance <span class="mono">${fmt(fail,0)}%</span></div>
          </div>
          <div class="right">
            <div class="hint">${reasons.length?reasons[0]:""}</div>
          </div>
        </div>
        <div class="card-body">
          <button class="btn btn-primary" data-testflight="${a.id}" ${enabled?"":"disabled"} title="${reasons.join(" | ")}">Queue test flight</button>
          ${reasons.length?`<div class="req">${reasons.map(reasonLine).join("")}</div>`:""}
        </div>
      </div>
    `;
  }).join("");

  // Orbit parts list
  const partsHtml = CONFIG.orbitParts.map(p=>{
    const techOk = hasTech(p.techPrereq);
    const lrlReq = p.requiresLRL ?? (p.id.startsWith("P_COMPUTE_RACK") ? 3 : 0);
    const lrlOk = sp.launchReadinessLevel >= lrlReq;
    const canLaunch = canLaunchPayload();

    const available = techOk && lrlOk && canLaunch;

    const effects = [];
    const prov = p.provides || {};
    if(prov.orbitPowerMW) effects.push(`+${prov.orbitPowerMW} MW power`);
    if(prov.radiatorMWth) effects.push(`+${prov.radiatorMWth} MWth radiators`);
    if(prov.computeLoadMW) effects.push(`+${prov.computeLoadMW} MW compute`);
    if(prov.comms) effects.push(`Comms`);
    if(prov.servicing) effects.push(`Servicing`);

    const lock = [];
    if(!techOk) lock.push(`Missing tech prereq: ${p.techPrereq}`);
    if(!canLaunch) lock.push("LRL gate: requires LRL >= 2");
    if(!lrlOk) lock.push(`LRL gate: requires LRL >= ${lrlReq}`);
    if(!canAfford(p.cost)) lock.push(`Insufficient credits: need ${formatCredits(p.cost)}, remaining ${formatCredits(creditsRemaining())}`);

    const selected = (queueFind("payloadLaunch")?.partIds || []).includes(p.id);

    return `
      <div class="card">
        <div class="card-header">
          <div>
            <div class="card-title">${p.name} ${selected?'<span class="chip good">Selected</span>':""}</div>
            <div class="card-subtitle">C${fmt(p.cost,0)}  |  ${fmt(p.mass_t,0)} t  |  ${effects.join("  |  ") || "--"}</div>
          </div>
          <div class="right">
            <div class="hint">${lock.length?`Locked: ${lock.join(", ")}`:""}</div>
          </div>
        </div>
        <div class="card-body">
          <button class="btn btn-primary" data-part-add="${p.id}" ${available && !RUN.won && !RUN.lost?"":"disabled"} title="${lock.join(" | ")}">Add to manifest</button>
          <button class="btn btn-ghost" data-part-remove="${p.id}" ${selected?"":"disabled"}>Remove</button>
          ${lock.length?`<div class="req">${lock.map(reasonLine).join("")}</div>`:""}
        </div>
      </div>
    `;
  }).join("");

  // Manifest
  const manifest = queueFind("payloadLaunch")?.partIds || [];
  const manifestParts = manifest.map(id=>CONFIG.orbitParts.find(p=>p.id===id)).filter(Boolean);
  const mass = manifestParts.reduce((s,p)=>s+(p.mass_t||0),0);
  const partsCost = manifestParts.reduce((s,p)=>s+(p.cost||0),0);
  const payloadCost = computePayloadLaunchCost(mass);

  const queuePayloadReasons = [];
  if(!canLaunchPayload()) queuePayloadReasons.push("LRL gate: requires LRL >= 2");
  if(manifest.length===0) queuePayloadReasons.push("Add at least one part to manifest");
  if(queueHas("payloadLaunch")) queuePayloadReasons.push("Payload launch already queued");
  if(manifest.length > 0 && !canAfford(partsCost + payloadCost)) queuePayloadReasons.push(`Insufficient credits: need ${formatCredits(partsCost + payloadCost)}, remaining ${formatCredits(creditsRemaining())}`);
  const queuePayloadEnabled = queuePayloadReasons.length===0 && !RUN.won && !RUN.lost;
  const alreadyQueuedPayload = queueHas("payloadLaunch");

  const manifestHtml = manifestParts.length ? `
    <div class="mono small">${manifestParts.map(p=>`- ${p.name} (${fmt(p.mass_t,0)}t)`).join("<br>")}</div>
  ` : `<div class="muted">No parts selected.</div>`;

  $("#panel-space").innerHTML = `
    <div class="grid">
      <div class="card">
        <div class="card-header">
          <div>
            <div class="card-title">Launch Program</div>
            <div class="card-subtitle">Build capability (LRL 0->3) before deploying orbital compute.</div>
          </div>
          <div class="right">
            <div class="mono">LRL ${sp.launchReadinessLevel}</div>
            <div class="hint">Successes ${sp.successfulFlights}  |  Failures ${sp.failedFlights}</div>
          </div>
        </div>
        <div class="card-body">
          <div style="margin-bottom:10px">${launchAssetsHtml}</div>
          <div class="grid cards">${testFlightHtml}</div>
        </div>
      </div>

      <div class="card">
        <div class="card-header">
          <div>
            <div class="card-title">Orbit Status</div>
            <div class="card-subtitle">Power, radiators, and compute balance.</div>
          </div>
        </div>
        <div class="grid-2">
          <div class="kpi"><div class="label">Orbit Power</div><div class="value mono">${fmt(orbit.orbitPowerMW,0)} MW</div></div>
          <div class="kpi"><div class="label">Radiators</div><div class="value mono">${fmt(orbit.radiatorMWth,0)} MWth</div></div>
          <div class="kpi"><div class="label">Compute Load</div><div class="value mono">${fmt(orbit.effectiveComputeLoadMW,0)} MW</div><div class="hint">(capped by orbit power)</div></div>
          <div class="kpi"><div class="label">Throttle</div><div class="value mono">${fmt(orbit.throttleFactor*100,0)}%</div><div class="hint">Need radiators ~ compute for 100%</div></div>
          <div class="kpi"><div class="label">ODC Delivered</div><div class="value mono">${fmt(sp.totalComputeDelivered,0)} CU</div></div>
          <div class="kpi"><div class="label">ODC Turns</div><div class="value mono">${sp.odcTurnsOperational}</div></div>
        </div>
      </div>

      <div class="card">
        <div class="card-header">
          <div>
            <div class="card-title">Orbit Assembly</div>
            <div class="card-subtitle">Select parts into a manifest, then queue a payload launch (LRL >= 2).</div>
          </div>
          <div class="right">
            <div class="hint">Payload launch cost scales with mass.</div>
          </div>
        </div>
        <div class="grid-2">
          <div>
            <div class="section-title">Available Parts</div>
            <div class="grid cards">${partsHtml}</div>
          </div>
          <div>
            <div class="section-title">Manifest</div>
            <div class="card">
              <div class="card-body">
                ${manifestHtml}
                <hr>
                <div class="mono">Parts cost: C${fmt(partsCost,0)}</div>
                <div class="mono">Payload mass: ${fmt(mass,0)} t</div>
                <div class="mono">Payload launch cost: C${fmt(payloadCost,0)}</div>
                <div class="mono" style="margin-top:8px">Total: C${fmt(partsCost + payloadCost,0)}</div>
                <div style="margin-top:10px">
                  <button class="btn btn-primary" id="btn-queue-payload" ${queuePayloadEnabled && !alreadyQueuedPayload?"":"disabled"} title="${queuePayloadReasons.join(" | ")}">Queue payload launch</button>
                  <button class="btn btn-ghost" id="btn-clear-manifest" ${manifest.length?"":"disabled"}>Clear manifest</button>
                </div>
                ${queuePayloadReasons.length?`<div class="req">${queuePayloadReasons.map(reasonLine).join("")}</div>`:""}
              </div>
            </div>
          </div>
        </div>
      </div>

    </div>
  `;

  // Test flight handlers
  $$('[data-testflight]').forEach(btn=>btn.addEventListener('click',(e)=>{
    const id = e.currentTarget.getAttribute('data-testflight');
    const action = CONFIG.actions.find(a=>a.id===id);
    if(!action) return;
    if(queueHas("testFlight")){
      toast("One test flight per turn.");
      return;
    }
    if(action.requiresTech && !hasTech(action.requiresTech)){
      toast(`Locked: missing tech prereq ${action.requiresTech}.`);
      return;
    }
    const missingBuild = (action.requires||[]).find(bid=>!hasBuilt(bid));
    if(missingBuild){
      toast(`Locked: missing required build ${missingBuild}.`);
      return;
    }
    if(sp.launchReadinessLevel < (action.minLRL||0)){
      toast(`Locked: LRL gate requires LRL >= ${action.minLRL || 0}.`);
      return;
    }
    if(sp.testFlightCooldownTurns > 0){
      toast(`Test flight cooldown: ${sp.testFlightCooldownTurns} turn(s) remaining.`);
      return;
    }
    if(!budgetGuard(action.flightCost, action.name)){
      return;
    }
    RUN.queue.push({ kind:"testFlight", actionId:id });
    render(); saveRun();
  }));

  // Manifest add/remove
  $$('[data-part-add]').forEach(btn=>btn.addEventListener('click',(e)=>{
    const id = e.currentTarget.getAttribute('data-part-add');
    const part = CONFIG.orbitParts.find(p=>p.id===id);
    if(!part) return;

    // prereqs
    if(!canLaunchPayload()){
      toast("Locked: need LRL >= 2 to launch payloads.");
      return;
    }
    if(part.techPrereq && !hasTech(part.techPrereq)){
      toast(`Locked: requires tech ${part.techPrereq}`);
      return;
    }
    const lrlReq = part.requiresLRL ?? (id.startsWith("P_COMPUTE_RACK") ? 3 : 0);
    if(RUN.state.space.launchReadinessLevel < lrlReq){
      toast(`Locked: requires LRL >= ${lrlReq}`);
      return;
    }

    // compute prospective cost impact
    let pl = queueFind("payloadLaunch");
    const currentIds = pl?.partIds ? [...pl.partIds] : [];
    if(currentIds.includes(id)){
      toast("Already in manifest.");
      return;
    }
    const nextIds = [...currentIds, id];
    const nextParts = nextIds.map(pid=>CONFIG.orbitParts.find(p=>p.id===pid)).filter(Boolean);
    const nextMass = nextParts.reduce((s,p)=>s+(p.mass_t||0),0);
    const nextPartsCost = nextParts.reduce((s,p)=>s+(p.cost||0),0);
    const nextPayloadCost = computePayloadLaunchCost(nextMass);
    const nextTotal = nextPartsCost + nextPayloadCost;

    // current payload total (if any)
    const curParts = currentIds.map(pid=>CONFIG.orbitParts.find(p=>p.id===pid)).filter(Boolean);
    const curMass = curParts.reduce((s,p)=>s+(p.mass_t||0),0);
    const curPartsCost = curParts.reduce((s,p)=>s+(p.cost||0),0);
    const curPayloadCost = currentIds.length ? computePayloadLaunchCost(curMass) : 0;
    const curTotal = currentIds.length ? (curPartsCost + curPayloadCost) : 0;

    const incremental = nextTotal - curTotal;
    if(!budgetGuard(incremental, `${part.name} manifest add`)){
      return;
    }

    if(!pl){
      pl = { kind:"payloadLaunch", partIds:[], payloadMass_t:0 };
      RUN.queue.push(pl);
    }
    pl.partIds = nextIds;
    // recompute mass
    pl.payloadMass_t = pl.partIds.map(pid=>CONFIG.orbitParts.find(p=>p.id===pid)).filter(Boolean).reduce((s,p)=>s+(p.mass_t||0),0);
    render(); saveRun();
  }));

  $$('[data-part-remove]').forEach(btn=>btn.addEventListener('click',(e)=>{
    const id = e.currentTarget.getAttribute('data-part-remove');
    const pl = queueFind("payloadLaunch");
    if(!pl) return;
    pl.partIds = pl.partIds.filter(x=>x!==id);
    pl.payloadMass_t = pl.partIds.map(pid=>CONFIG.orbitParts.find(p=>p.id===pid)).filter(Boolean).reduce((s,p)=>s+(p.mass_t||0),0);
    if(pl.partIds.length===0){
      RUN.queue = RUN.queue.filter(q=>q!==pl);
    }
    render(); saveRun();
  }));

  $('#btn-queue-payload')?.addEventListener('click',()=>{
    if(queuePayloadReasons.length){
      toast(`Cannot queue payload launch: ${queuePayloadReasons[0]}`);
      return;
    }
    if(!budgetGuard(partsCost + payloadCost, "payload launch")){
      return;
    }
    toast("Payload launch queued.");
    render(); saveRun();
  });

  $('#btn-clear-manifest')?.addEventListener('click',()=>{
    RUN.queue = RUN.queue.filter(q=>q.kind!=="payloadLaunch");
    render(); saveRun();
  });
}

function renderReportsTab(){
  const r = RUN.lastReport;
  if(!r){
    $("#panel-reports").innerHTML = `
      <div class="card">
        <div class="card-header"><div><div class="card-title">Reports</div><div class="card-subtitle">End a turn to see a breakdown.</div></div></div>
        <div class="card-body"><div class="muted">No turns completed yet.</div></div>
      </div>
    `;
    return;
  }

  const tf = r.testFlightResult;
  const tfHtml = tf ? `
    <div class="mono small">
      ${tf.actionId}: ${tf.ok ? "OK Success" : "FAIL Failed"}
      ${tf.failChance != null ? `  |  FailChance ${fmt(tf.failChance,0)}%  |  Roll ${fmt(tf.roll,0)}` : ""}
    </div>
  ` : `<div class="muted">No test flight.</div>`;

  const pl = r.payloadResult;
  const plHtml = pl ? `
    <div class="mono small">
      Payload launch: ${pl.ok?"OK":"FAIL"}
      ${pl.launchFailure?"  |  Launch failure event hit":""}
      ${pl.lostParts?.length?`<br>Lost: ${pl.lostParts.join(", ")}`:""}
      ${pl.keptParts?.length?`<br>Kept: ${pl.keptParts.join(", ")}`:""}
    </div>
  ` : `<div class="muted">No payload launch.</div>`;

  $("#panel-reports").innerHTML = `
    <div class="grid">
      <div class="card">
        <div class="card-header">
          <div>
            <div class="card-title">Turn ${r.turn} Report</div>
            <div class="card-subtitle">Event: <span class="mono">${r.event}</span> (${r.eventId})</div>
          </div>
        </div>
        <div class="card-body">
          <div class="section-title">Actions</div>
          <div class="muted">Research: <span class="mono">${r.researchThisTurn || "--"}</span></div>
          <div class="muted">Built: <span class="mono">${(r.builtThisTurn||[]).join(", ") || "--"}</span></div>
          <hr>
          <div class="section-title">Test Flight</div>
          ${tfHtml}
          <hr>
          <div class="section-title">Payload Launch</div>
          ${plHtml}
        </div>
      </div>

      <div class="card">
        <div class="card-header"><div><div class="card-title">Earth</div><div class="card-subtitle">Demand, generation, curtailment, and stress.</div></div></div>
        <div class="card-body">
          <div class="mono">Demand: ${fmt(r.earth.demandTW,1)} TW</div>
          <div class="mono">Solar/Wind multiplier: ${fmt(r.earth.solarWindMultiplier,2)}</div>
          <div class="mono">Generated: ${fmt(r.earth.generatedTW,1)} TW</div>
          <div class="mono">Curtailment: ${fmt(r.earth.curtailmentTW,1)} TW</div>
          <div class="mono">Usable: ${fmt(r.earth.usablePowerTW,1)} TW</div>
          <hr>
          <div class="mono">Reliability: ${fmt(r.earth.reliability,1)}%</div>
          <div class="mono">Emissions: ${fmt(r.earth.emissionsIndex,0)}</div>
          <div class="mono">Heat Stress: ${fmt(r.earth.heatStress,0)}</div>
        </div>
      </div>

      <div class="card">
        <div class="card-header"><div><div class="card-title">Space</div><div class="card-subtitle">Power, radiators, throttle, uptime.</div></div></div>
        <div class="card-body">
          <div class="mono">LRL: ${r.space.lrl}</div>
          <div class="mono">Orbit power: ${fmt(r.space.orbitPowerMW,0)} MW</div>
          <div class="mono">Radiators: ${fmt(r.space.radiatorMWth,0)} MWth</div>
          <div class="mono">Compute load: ${fmt(r.space.effectiveComputeLoadMW,0)} MW</div>
          <div class="mono">Throttle: ${fmt(r.space.throttleFactor*100,0)}%</div>
          <div class="mono">Uptime: ${fmt(r.space.uptime,0)}%</div>
          <div class="mono">Delivered this turn: ${fmt(r.space.deliveredCU,1)} CU</div>
          <hr>
          <div class="mono">Total CU: ${fmt(r.space.totalComputeDelivered,0)}</div>
          <div class="mono">ODC turns: ${r.space.odcTurnsOperational}</div>
          <div class="mono">ODC failed: ${r.space.odcFailed ? "YES" : "NO"}</div>
        </div>
      </div>

      <div class="card">
        <div class="card-header"><div><div class="card-title">Finances</div><div class="card-subtitle">Where the money went.</div></div></div>
        <div class="card-body">
          <div class="mono">Spent: C${fmt(r.finances.spent,0)}</div>
          <div class="mono">Income: C${fmt(r.finances.income,0)}</div>
          <div class="mono">Event Delta: C${fmt(r.finances.eventCreditsDelta,0)}</div>
          <hr>
          <div class="mono">End credits: C${fmt(r.finances.endCredits,0)}</div>
        </div>
      </div>

    </div>
  `;
}

// ---------- Tab navigation + init ----------

function initTabs(){
  $$(".tab").forEach(btn=>btn.addEventListener("click", ()=>{
    $$(".tab").forEach(b=>b.classList.remove("active"));
    btn.classList.add("active");
    const tab = btn.getAttribute("data-tab");
    $$(".panel").forEach(p=>p.classList.remove("active"));
    $("#panel-"+tab).classList.add("active");
  }));
}

function initModal(){
  $("#modal")?.addEventListener("click", (e)=>{
    const t = e.target;
    if(t && t.getAttribute && t.getAttribute("data-close") === "true") hideModal();
  });
}

function initHeader(){
  $("#btn-new").addEventListener("click", ()=>{
    if(confirm("Start a new run? This will reset your current run.")){
      RUN = newRun();
      saveRun();
      render();
    }
  });
}

// initial render
initTabs();
initModal();
initHeader();
render();

// minimal toast styles
(function injectToastCSS(){
  const style = document.createElement('style');
  style.textContent = `
    .toast{position:fixed; left:50%; bottom:86px; transform:translateX(-50%); background:rgba(18,24,38,.95); border:1px solid var(--border); color:var(--text); padding:10px 12px; border-radius:999px; opacity:0; transition:opacity .2s, transform .2s; z-index:100;}
    .toast.show{opacity:1; transform:translateX(-50%) translateY(-4px);}
  `;
  document.head.appendChild(style);
})();

