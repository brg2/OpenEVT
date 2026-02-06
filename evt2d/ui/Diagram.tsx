import React from "react";
import type { SimConfig, SimState } from "../sim/types";

interface DiagramProps {
  state: SimState | null;
  config: SimConfig;
}

const flowWidth = (kw: number) => {
  const mag = Math.min(1, Math.abs(kw) / 200);
  return 2 + mag * 8;
};

const flowColor = (kw: number, positive: string, negative: string) =>
  kw >= 0 ? positive : negative;

const Diagram: React.FC<DiagramProps> = ({ state, config }) => {
  const pEng = state?.pEngMechKw ?? 0;
  const pGen = state?.pGenElecKw ?? 0;
  const pBatt = state?.pBattKw ?? 0;
  const pTrac = state?.pTracElecKw ?? 0;
  const pWheels = state?.pWheelsKw ?? 0;

  const limiter = state?.limiter;

  return (
    <div style={{ height: "100%" }}>
      <svg viewBox="0 0 900 520" role="img">
        <defs>
          <linearGradient id="node" x1="0" x2="1">
            <stop offset="0%" stopColor="#1c2634" />
            <stop offset="100%" stopColor="#0f1721" />
          </linearGradient>
        </defs>

        <rect x="40" y="40" width="200" height="90" rx="16" fill="url(#node)" stroke="#2a3647" />
        <text x="60" y="80" fill="#d9e1ea" fontSize="16">
          ICE Engine
        </text>
        <text x="60" y="105" fill="#7f92a6" fontSize="13">
          Accelerator → {Math.round((state?.rpm ?? 0))} rpm
        </text>

        <rect x="300" y="40" width="200" height="90" rx="16" fill="url(#node)" stroke="#2a3647" />
        <text x="320" y="80" fill="#d9e1ea" fontSize="16">
          Generator
        </text>
        <text x="320" y="105" fill="#7f92a6" fontSize="13">
          Rectifier
        </text>

        <rect x="560" y="40" width="200" height="90" rx="16" fill="url(#node)" stroke="#2a3647" />
        <text x="580" y="80" fill="#d9e1ea" fontSize="16">
          HV DC Bus
        </text>
        <text x="580" y="105" fill="#7f92a6" fontSize="13">
          {state ? state.vBus.toFixed(0) : "--"} V
        </text>

        <rect x="560" y="190" width="200" height="90" rx="16" fill="url(#node)" stroke="#2a3647" />
        <text x="580" y="230" fill="#d9e1ea" fontSize="16">
          Battery
        </text>
        <text x="580" y="255" fill="#7f92a6" fontSize="13">
          SOC {(state?.soc ?? 0).toFixed(2)}
        </text>

        <rect x="300" y="330" width="200" height="90" rx="16" fill="url(#node)" stroke="#2a3647" />
        <text x="320" y="370" fill="#d9e1ea" fontSize="16">
          Traction Inverter
        </text>
        <text x="320" y="395" fill="#7f92a6" fontSize="13">
          APS {Math.round((state?.pWheelsReqKw ?? 0))} kW req
        </text>

        <rect x="40" y="330" width="200" height="90" rx="16" fill="url(#node)" stroke="#2a3647" />
        <text x="60" y="370" fill="#d9e1ea" fontSize="16">
          Wheels
        </text>
        <text x="60" y="395" fill="#7f92a6" fontSize="13">
          {Math.round(pWheels)} kW
        </text>

        <line
          x1="240"
          y1="85"
          x2="300"
          y2="85"
          stroke={flowColor(pEng, "#47b3ff", "#79f2c0")}
          strokeWidth={flowWidth(pEng)}
        />
        <text x="250" y="70" fill="#a6b6c6" fontSize="12">
          {pEng.toFixed(1)} kW
        </text>

        <line
          x1="500"
          y1="85"
          x2="560"
          y2="85"
          stroke={flowColor(pGen, "#47b3ff", "#79f2c0")}
          strokeWidth={flowWidth(pGen)}
        />
        <text x="510" y="70" fill="#a6b6c6" fontSize="12">
          {pGen.toFixed(1)} kW
        </text>

        <line
          x1="660"
          y1="130"
          x2="660"
          y2="190"
          stroke={flowColor(-pBatt, "#79f2c0", "#ffb020")}
          strokeWidth={flowWidth(pBatt)}
        />
        <text x="672" y="165" fill="#a6b6c6" fontSize="12">
          {pBatt.toFixed(1)} kW
        </text>

        <line
          x1="560"
          y1="85"
          x2="500"
          y2="330"
          stroke={flowColor(pTrac, "#47b3ff", "#79f2c0")}
          strokeWidth={flowWidth(pTrac)}
        />
        <text x="500" y="220" fill="#a6b6c6" fontSize="12">
          {pTrac.toFixed(1)} kW
        </text>

        <line
          x1="300"
          y1="375"
          x2="240"
          y2="375"
          stroke={flowColor(pWheels, "#47b3ff", "#79f2c0")}
          strokeWidth={flowWidth(pWheels)}
        />
        <text x="250" y="360" fill="#a6b6c6" fontSize="12">
          {pWheels.toFixed(1)} kW
        </text>
      </svg>

      <div style={{ position: "absolute", top: 16, right: 16, display: "grid", gap: 6 }}>
        {limiter?.battDischarge && (
          <span className="badge warn">Battery Discharge Limit</span>
        )}
        {limiter?.battCharge && (
          <span className="badge warn">Battery Charge Limit</span>
        )}
        {limiter?.busUv && <span className="badge danger">Bus Undervoltage</span>}
        {limiter?.busOv && <span className="badge danger">Bus Overvoltage</span>}
      </div>
    </div>
  );
};

export default Diagram;
