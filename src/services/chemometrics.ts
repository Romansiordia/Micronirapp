import { ModelJSON, PredictionResult } from "../types";
import { applySNV, applyMSC, applySavGol } from "./preprocessing";

/**
 * Chemometrics prediction engine
 */
export const predict = (
  absorbance: number[],
  model: ModelJSON,
  onLog?: (msg: string, type?: string) => void
): PredictionResult => {
  let processed = [...absorbance];

  // 1. Apply Cascade Preprocessing
  if (model.preprocessing && Array.isArray(model.preprocessing)) {
    for (const step of model.preprocessing) {
      const method = (step.method || "").toLowerCase();
      onLog?.(`Procesando: ${method.toUpperCase()}...`, "log-default");

      if (method === "snv") {
        processed = applySNV(processed);
      } else if (method === "msc") {
        const ref = model.metrics?.referenceSpectrum || model.referenceSpectrum;
        if (ref) {
          processed = applyMSC(processed, ref);
        } else {
          onLog?.("Advertencia: Se requiere espectro de referencia para MSC", "log-warn");
        }
      } else if (method.includes("savgol")) {
        const deriv = method.includes("1") ? 1 : method.includes("2") ? 2 : 0;
        processed = applySavGol(
          processed,
          step.params?.windowSize || 11,
          step.params?.polynomialOrder || 2,
          deriv
        );
      }
    }
  }

  // 2. Apply PLS Regression Equation
  const intercept = model.metrics?.plsIntercept ?? model.plsIntercept ?? 0;
  const coefficients = model.metrics?.coefficients || model.coefficients;

  if (!coefficients) {
    throw new Error("Faltan coeficientes de regresión en el modelo");
  }

  let prediction = intercept;
  const len = Math.min(processed.length, coefficients.length);
  for (let i = 0; i < len; i++) {
    prediction += processed[i] * coefficients[i];
  }

  return {
    property: model.analyticalProperty,
    value: prediction,
    unit: model.unit || "%",
  };
};
