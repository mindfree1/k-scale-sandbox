/* Locked V0 config (semi-realistic, 18 turns). */
const CONFIG = {
  "constants": {
    "turnLength": "quarter",
    "turnLimit": 18,
    "currency": "credits",
    "startingCredits": 120,

    "income": {
      "base": 12,
      "powerBonusPerTWAbove20": 0.5,
      "powerBonusCap": 15,
      "reliabilityBonusIfAtLeast99": 4,
      "blackoutPenaltyIfBelow95": -6
    },

    "launchEconomics": {
      "payloadLaunchBaseCost": 6,
      "payloadCostPerTonne": 0.15,
      "ifBuilt_B_LAUNCH_FACTORY": { "payloadLaunchBaseCostDelta": -1 }
    },

    "win": {
      "usablePowerTW_min": 40,
      "reliability_min": 99.0,
      "heatStress_max": 70,
      "odcTurnsOperational_min": 4,
      "computeDelivered_min": 200
    },

    "lose": {
      "heatStress_atLeast": 100,
      "reliabilityBelow92_consecutiveTurns": 2,
      "odcCatastrophicFailBeforeCompute": true,
      "turnLimitReachedWithoutWin": true
    },

    "startingState": {
      "earth": {
        "demandTW": 20.0,
        "solarGenTW": 0.8,
        "windGenTW": 0.6,
        "firmGenTW": 19.6,

        "reliability": 96.0,
        "emissionsIndex": 60.0,
        "heatStress": 25.0,

        "batteryBlocks": 0,
        "hvSegments": 0,
        "hydrogenPlants": 0,
        "demandResponsePrograms": 0,

        "builtCounts": {}
      },

      "space": {
        "launchReadinessLevel": 0,
        "launchCapacity_t_per_turn": 0,
        "orbitMass_t": 0,
        "orbitParts": [],
        "totalComputeDelivered": 0,
        "odcTurnsOperational": 0,
        "odcFailed": false,

        "successfulFlights": 0,
        "failedFlights": 0,
        "testFlightCooldownTurns": 0,

        "payloadLaunchedThisTurn": false,
        "payloadMassThisTurn_t": 0
      },

      "flags": {
        "reliabilityBelow92Streak": 0,
        "nextTestFlightFailureMinus": 0,
        "activeCostModifiers": []
      }
    }
  },

  "rules": {
    "research": {
      "maxPerTurn": 1,
      "appliesImmediatelyThisTurn": true
    },

    "eventTiming": "afterPurchasesBeforeSystemResolution",

    "earth": {
      "generatedTW": "firmGenTW + (solarGenTW + windGenTW)*solarWindMultiplier",
      "curtailmentFormula": "max(0, generatedTW - demandTW - (batteryBlocks*0.6) - (hvSegments*0.3))",
      "usablePower": "min(generatedTW - curtailmentTW, demandTW)",

      "variabilityPenaltyRule": {
        "ifVariableShareGreaterThan": 0.5,
        "andBatteryBlocksLessThan": 2,
        "andHVSegmentsLessThan": 1,
        "thenReliabilityMinus": 1.0
      },

      "eventMitigation": {
        "hvSegmentsMultiplyReliabilityShockPerSegment": 0.8,
        "batteriesMultiplyReliabilityShockIfAtLeastOneBattery": 0.7,
        "demandResponseHalvesDemandShockIfAtLeastOneProgram": true,
        "demandResponseMultipliesReliabilityShockIfAtLeastOneProgram": 0.7
      },

      "heatStressUpdate": {
        "add_perTWAbove20": 0.6,
        "add_emissionsIndexMultiplier": 0.05,
        "subtract_hvSegment": 0.3,
        "subtract_batteryBlock": 0.2,
        "subtract_hydrogenPlant": 0.4,
        "clampMin": 0,
        "clampMax": 120
      },

      "reliabilityClamp": { "min": 80.0, "max": 99.9 },
      "emissionsClamp": { "min": 0.0, "max": 100.0 }
    },

    "space": {
      "launchGating": {
        "canLaunchOrbitPartsIfLRLAtLeast": 2,
        "canBuyComputeRacksIfLRLEquals": 3
      },

      "payloadLaunchCostRule": {
        "cost": "payloadLaunchBaseCost + payloadCostPerTonne * payloadMassThisTurn_t",
        "payloadLaunchBaseCostAdjustedIfFactoryBuilt": true
      },

      "computePowerConstraint": "effectiveComputeLoadMW = min(totalComputeRackLoadMW, orbitPowerMW)",

      "thermal": {
        "heatLoadMWth": "effectiveComputeLoadMW * 0.95",
        "throttleFactor": "min(1.0, radiatorMWth / heatLoadMWth)",
        "thermalDangerIfThrottleBelow": 0.7
      },

      "uptime": {
        "baseStandard": 85,
        "baseRadHard": 93,
        "servicingBonus": 5,
        "radiationStormPenalty": 20,
        "servicingReducesRadiationPenaltyMultiplier": 0.7,
        "thermalDangerPenalty": 15,
        "clampMin": 0,
        "clampMax": 99
      },

      "compute": {
        "standardEfficiencyCUPerMW": 1.0,
        "radHardEfficiencyCUPerMW": 0.9,
        "deliveredCU": "rawCU * throttleFactor * (uptime/100)"
      },

      "operationalTurnDefinition": {
        "countsAsOperationalIfUptimeAtLeast": 60,
        "andDeliveredCUGreaterThan": 0
      },

      "catastrophicFailure": {
        "checkEachTurnIfODCActive": true,
        "thresholds": [
          { "condition": "thermalDanger", "failIfRollAtLeast": 15 },
          { "condition": "radiationStorm_and_hasStandardRacks", "failIfRollAtLeast": 12 },
          { "condition": "payloadLaunchedThisTurn_and_noServicing", "failIfRollAtLeast": 8 }
        ],
        "useHighestFailureChance": true,
        "onFail": {
          "removeRandomOrbitPart": true,
          "setODCFailed": true,
          "loseIfComputeDeliveredBelowTarget": true
        }
      }
    }
  },

  "techs": [
    { "id": "T_GRID", "name": "Grid Modernization", "cost": 10, "prereqs": [], "unlocks": ["B_HV_SEGMENT"] },
    { "id": "T_SOLAR", "name": "Utility Solar", "cost": 6, "prereqs": [], "unlocks": ["B_SOLAR_FARM"] },
    { "id": "T_WIND", "name": "Wind Buildout", "cost": 6, "prereqs": [], "unlocks": ["B_WIND_FARM"] },
    { "id": "T_BATTERY", "name": "Storage: Batteries", "cost": 8, "prereqs": ["T_GRID"], "unlocks": ["B_BATTERY_BLOCK"] },
    { "id": "T_DEMAND", "name": "Demand Response", "cost": 6, "prereqs": ["T_GRID"], "unlocks": ["B_DEMAND_RESPONSE"] },
    { "id": "T_NUCLEAR", "name": "Firm Power: Nuclear", "cost": 10, "prereqs": ["T_GRID"], "unlocks": ["B_NUCLEAR"] },

    { "id": "T_ELECTRIFY", "name": "High-Temp Electrification", "cost": 9, "prereqs": ["T_BATTERY"], "unlocks": ["B_INDUSTRY_ELECTRIFY"] },
    { "id": "T_H2", "name": "Green Hydrogen", "cost": 9, "prereqs": ["T_ELECTRIFY"], "unlocks": ["B_H2_PLANT"] },

    { "id": "T_LAUNCH_SYS", "name": "Launch Systems R&D", "cost": 8, "prereqs": [], "unlocks": ["B_LAUNCH_SITE", "B_ENGINE_AVIONICS", "A_TEST_FLIGHT_SUBORBITAL"] },
    { "id": "T_ORBITAL_DEV", "name": "Orbital Launcher Development", "cost": 10, "prereqs": ["T_LAUNCH_SYS"], "unlocks": ["A_TEST_FLIGHT_ORBITAL_DEMO"] },
    { "id": "T_REUSE", "name": "Operational Cadence & Reuse", "cost": 12, "prereqs": ["T_ORBITAL_DEV"], "unlocks": ["A_TEST_FLIGHT_OPERATIONAL", "B_LAUNCH_FACTORY"] },

    { "id": "T_ORB_SOLAR", "name": "Orbital Solar Arrays", "cost": 7, "prereqs": ["T_ORBITAL_DEV"], "unlocks": ["P_ORB_SOLAR_ARRAY"] },
    { "id": "T_RADIATORS", "name": "Thermal Radiators", "cost": 7, "prereqs": ["T_ORBITAL_DEV"], "unlocks": ["P_RADIATOR_PANEL"] },
    { "id": "T_COMMS", "name": "Comms Link", "cost": 6, "prereqs": ["T_ORBITAL_DEV"], "unlocks": ["P_COMMS_PACKAGE"] },
    { "id": "T_SERVICING", "name": "Orbital Servicing", "cost": 8, "prereqs": ["T_REUSE"], "unlocks": ["P_SERVICING_KIT"] },
    { "id": "T_RADHARD", "name": "Radiation Hardening", "cost": 9, "prereqs": ["T_SERVICING"], "unlocks": ["P_COMPUTE_RACK_RADHARD"] },

    { "id": "T_ODC", "name": "Orbital Data Center Demo", "cost": 12, "prereqs": ["T_ORB_SOLAR", "T_RADIATORS"], "unlocks": ["P_COMPUTE_RACK_STANDARD"] }
  ],

  "earthBuilds": [
    {
      "id": "B_SOLAR_FARM",
      "name": "Utility Solar Farm",
      "cost": 8,
      "techPrereq": "T_SOLAR",
      "deltas": { "solarGenTW": 1.8, "windGenTW": 0, "firmGenTW": 0, "demandTW": 0, "reliability": -0.2, "emissionsIndex": -1, "heatStress": 1 },
      "tags": ["solar", "variable"]
    },
    {
      "id": "B_WIND_FARM",
      "name": "Wind Farm",
      "cost": 8,
      "techPrereq": "T_WIND",
      "deltas": { "solarGenTW": 0, "windGenTW": 1.5, "firmGenTW": 0, "demandTW": 0, "reliability": -0.2, "emissionsIndex": -1, "heatStress": 1 },
      "tags": ["wind", "variable"]
    },
    {
      "id": "B_NUCLEAR",
      "name": "Nuclear Plant",
      "cost": 18,
      "techPrereq": "T_NUCLEAR",
      "deltas": { "solarGenTW": 0, "windGenTW": 0, "firmGenTW": 2.5, "demandTW": 0, "reliability": 1.2, "emissionsIndex": -2, "heatStress": 1 },
      "tags": ["firm", "nuclear"]
    },
    {
      "id": "B_BATTERY_BLOCK",
      "name": "Battery Storage Block",
      "cost": 10,
      "techPrereq": "T_BATTERY",
      "deltas": { "batteryBlocks": 1, "reliability": 1.0, "heatStress": 0.5 },
      "tags": ["storage"]
    },
    {
      "id": "B_HV_SEGMENT",
      "name": "HV Supergrid Segment",
      "cost": 12,
      "techPrereq": "T_GRID",
      "deltas": { "hvSegments": 1, "reliability": 1.4, "heatStress": 0.5 },
      "tags": ["grid"]
    },
    {
      "id": "B_DEMAND_RESPONSE",
      "name": "Demand Response Program",
      "cost": 7,
      "techPrereq": "T_DEMAND",
      "deltas": { "demandResponsePrograms": 1, "reliability": 0.8, "heatStress": 0 },
      "tags": ["policy"]
    },
    {
      "id": "B_H2_PLANT",
      "name": "Green Hydrogen Plant",
      "cost": 14,
      "techPrereq": "T_H2",
      "deltas": { "hydrogenPlants": 1, "reliability": 0.6, "emissionsIndex": -1, "heatStress": 0.5 },
      "tags": ["storage", "industry"]
    },
    {
      "id": "B_INDUSTRY_ELECTRIFY",
      "name": "Industrial Electrification",
      "cost": 11,
      "techPrereq": "T_ELECTRIFY",
      "deltas": { "demandTW": 2.0, "reliability": -0.3, "emissionsIndex": -3, "heatStress": 2 },
      "tags": ["industry", "demand"]
    },

    {
      "id": "B_LAUNCH_SITE",
      "name": "Launch Site",
      "cost": 16,
      "techPrereq": "T_LAUNCH_SYS",
      "deltas": { "heatStress": 0.3 },
      "tags": ["launch"]
    },
    {
      "id": "B_ENGINE_AVIONICS",
      "name": "Engine & Avionics Program",
      "cost": 18,
      "techPrereq": "T_LAUNCH_SYS",
      "deltas": { "heatStress": 0.5 },
      "tags": ["launch"]
    },
    {
      "id": "B_LAUNCH_FACTORY",
      "name": "Launch Manufacturing Line",
      "cost": 22,
      "techPrereq": "T_REUSE",
      "deltas": { "heatStress": 0.7 },
      "tags": ["launch"]
    }
  ],

  "actions": [
    {
      "id": "A_TEST_FLIGHT_SUBORBITAL",
      "name": "Test Flight: Suborbital",
      "type": "testFlight",
      "flightCost": 4,
      "requires": ["B_LAUNCH_SITE"],
      "requiresTech": "T_LAUNCH_SYS",
      "minLRL": 0,
      "setsLRLToAtLeastOnSuccess": 1,
      "baseFailureChance": 38,
      "onFail": { "creditsDelta": -6, "heatStressDelta": 1, "cooldownTurns": 0 }
    },
    {
      "id": "A_TEST_FLIGHT_ORBITAL_DEMO",
      "name": "Test Flight: Orbital Demo",
      "type": "testFlight",
      "flightCost": 7,
      "requiresTech": "T_ORBITAL_DEV",
      "requires": ["B_LAUNCH_SITE", "B_ENGINE_AVIONICS"],
      "minLRL": 1,
      "setsLRLToAtLeastOnSuccess": 2,
      "baseFailureChance": 48,
      "onFail": { "creditsDelta": -6, "heatStressDelta": 1, "cooldownTurns": 1 }
    },
    {
      "id": "A_TEST_FLIGHT_OPERATIONAL",
      "name": "Test Flight: Operational Reliability",
      "type": "testFlight",
      "flightCost": 9,
      "requiresTech": "T_REUSE",
      "requires": ["B_LAUNCH_SITE", "B_ENGINE_AVIONICS", "B_LAUNCH_FACTORY"],
      "minLRL": 2,
      "setsLRLToAtLeastOnSuccess": 3,
      "baseFailureChance": 28,
      "onFail": { "creditsDelta": -6, "heatStressDelta": 1, "cooldownTurns": 1 }
    }
  ],

  "launchSystem": {
    "oneTestFlightPerTurn": true,

    "failureMitigation": [
      { "ifBuilt": "B_LAUNCH_SITE", "failureChanceMinus": 8 },
      { "ifBuilt": "B_ENGINE_AVIONICS", "failureChanceMinus": 12 },
      { "ifBuilt": "B_LAUNCH_FACTORY", "failureChanceMinus": 10 }
    ],

    "learningCurve": {
      "minusPerSuccessfulFlight": 2,
      "plusPerFailedFlight": 1
    },

    "temporaryMitigationFromEvent": { "breakthroughNextFlightMinus": 10 },

    "clampFailureChanceMin": 5,
    "clampFailureChanceMax": 90,

    "onSuccessCounters": { "successfulFlightsPlus": 1 },
    "onFailCounters": { "failedFlightsPlus": 1 }
  },

  "orbitParts": [
    {
      "id": "P_ORB_SOLAR_ARRAY",
      "name": "Orbital Solar Array",
      "cost": 9,
      "mass_t": 20,
      "techPrereq": "T_ORB_SOLAR",
      "provides": { "orbitPowerMW": 50 }
    },
    {
      "id": "P_RADIATOR_PANEL",
      "name": "Radiator Panel",
      "cost": 9,
      "mass_t": 25,
      "techPrereq": "T_RADIATORS",
      "provides": { "radiatorMWth": 80 }
    },
    {
      "id": "P_COMPUTE_RACK_STANDARD",
      "name": "Compute Rack (Standard)",
      "cost": 11,
      "mass_t": 18,
      "techPrereq": "T_ODC",
      "requiresLRL": 3,
      "provides": { "computeLoadMW": 30, "computeEff": 1.0, "rackType": "standard" }
    },
    {
      "id": "P_COMPUTE_RACK_RADHARD",
      "name": "Compute Rack (Rad-Hard)",
      "cost": 15,
      "mass_t": 22,
      "techPrereq": "T_RADHARD",
      "requiresLRL": 3,
      "provides": { "computeLoadMW": 25, "computeEff": 0.9, "rackType": "radhard" }
    },
    {
      "id": "P_COMMS_PACKAGE",
      "name": "Comms Package",
      "cost": 8,
      "mass_t": 10,
      "techPrereq": "T_COMMS",
      "provides": { "comms": true }
    },
    {
      "id": "P_SERVICING_KIT",
      "name": "Servicing Kit",
      "cost": 7,
      "mass_t": 15,
      "techPrereq": "T_SERVICING",
      "provides": { "servicing": true }
    }
  ],

  "events": [
    {
      "id": "E_HEATWAVE",
      "name": "Heatwave Demand Spike",
      "weight": 2,
      "modifiers": { "demandShockTW": 3, "reliabilityShock": -1.2 },
      "mitigations": {
        "demandResponseHalvesDemandShock": true,
        "batteriesReduceReliabilityShockMultiplier": 0.7
      }
    },
    {
      "id": "E_STORM",
      "name": "Storm Week",
      "weight": 2,
      "modifiers": { "solarWindMultiplier": 0.65, "reliabilityShock": -1.0 },
      "mitigations": { "hvSegmentsMultiplyReliabilityShock": 0.8 }
    },
    {
      "id": "E_SUPPLY_BATT",
      "name": "Supply Shock: Batteries",
      "weight": 1,
      "modifiers": {
        "buildCostModifier": { "targetBuildId": "B_BATTERY_BLOCK", "addCost": 4, "durationTurns": 2 }
      }
    },
    {
      "id": "E_BACKLASH_NUC",
      "name": "Public Backlash (Nuclear)",
      "weight": 1,
      "modifiers": {
        "conditionalIfHasTag": "nuclear",
        "reliabilityShock": -0.6,
        "buildCostModifier": { "targetBuildId": "B_NUCLEAR", "addCost": 6, "durationTurns": 2 }
      },
      "mitigations": { "demandResponseReducesReliabilityShockMultiplier": 0.7 }
    },
    {
      "id": "E_LAUNCH_FAIL",
      "name": "Launch Failure",
      "weight": 1,
      "modifiers": { "launchFailure": true }
    },
    {
      "id": "E_RAD_STORM",
      "name": "Radiation Storm",
      "weight": 1,
      "modifiers": { "radiationStorm": true }
    },
    {
      "id": "E_QUIET",
      "name": "Quiet Quarter",
      "weight": 3,
      "modifiers": {}
    },
    {
      "id": "E_BREAKTHROUGH",
      "name": "Breakthrough",
      "weight": 1,
      "modifiers": { "creditsDelta": 8, "nextTestFlightFailureMinus": 10 }
    }
  ]
};
