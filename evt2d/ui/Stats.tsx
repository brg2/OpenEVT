import React from "react";
import type { SimState } from "../sim/types";

interface StatsProps {
  state: SimState | null;
  distanceMiles: number;
  whPerMi: number;
  avgBusPowerKw: number;
}

const Stats: React.FC<StatsProps> = ({
  state,
  distanceMiles,
  whPerMi,
  avgBusPowerKw,
}) => {
  if (!state) return null;

  return (
    <div className="stats">
      <h2>Stats</h2>
      <div className="stat">
        <span>Distance</span>
        <strong>{distanceMiles.toFixed(2)} mi</strong>
      </div>
      <div className="stat">
        <span>Wh/mi</span>
        <strong>{whPerMi.toFixed(0)}</strong>
      </div>
      <div className="stat">
        <span>kWh Generated</span>
        <strong>{state.energy.eGenKwh.toFixed(2)}</strong>
      </div>
      <div className="stat">
        <span>kWh Traction</span>
        <strong>{state.energy.eTracOutKwh.toFixed(2)}</strong>
      </div>
      <div className="stat">
        <span>kWh Batt Discharge</span>
        <strong>{state.energy.eBattOutKwh.toFixed(2)}</strong>
      </div>
      <div className="stat">
        <span>kWh Batt Charge</span>
        <strong>{state.energy.eBattInKwh.toFixed(2)}</strong>
      </div>
      <div className="stat">
        <span>Fuel Used (gal)</span>
        <strong>{state.energy.fuelGallons.toFixed(3)}</strong>
      </div>
      <div className="stat">
        <span>Avg Bus Power</span>
        <strong>{avgBusPowerKw.toFixed(1)} kW</strong>
      </div>
      <div className="stat">
        <span>Limiter: Traction</span>
        <strong>{state.limiterTime.tracPower.toFixed(1)} s</strong>
      </div>
      <div className="stat">
        <span>Limiter: Batt Discharge</span>
        <strong>{state.limiterTime.battDischarge.toFixed(1)} s</strong>
      </div>
      <div className="stat">
        <span>Limiter: Batt Charge</span>
        <strong>{state.limiterTime.battCharge.toFixed(1)} s</strong>
      </div>
      <div className="stat">
        <span>Limiter: Bus UV</span>
        <strong>{state.limiterTime.busUv.toFixed(1)} s</strong>
      </div>
      <div className="stat">
        <span>Limiter: Bus OV</span>
        <strong>{state.limiterTime.busOv.toFixed(1)} s</strong>
      </div>
    </div>
  );
};

export default Stats;
