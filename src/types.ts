/**
 * Shared types for MicroNIR application
 */

export enum PreprocessingMethod {
  SNV = 'snv',
  MSC = 'msc',
  SAVGOL = 'savgol',
  SAVGOL1 = 'savgol1',
  SAVGOL2 = 'savgol2',
}

export interface PreprocessingParams {
  windowSize?: number;
  polynomialOrder?: number;
}

export interface PreprocessingStep {
  method: string;
  params?: PreprocessingParams;
}

export interface ModelMetrics {
  plsIntercept?: number;
  coefficients?: number[];
  referenceSpectrum?: number[];
  [key: string]: any;
}

export interface ModelJSON {
  analyticalProperty: string;
  preprocessing?: PreprocessingStep[];
  metrics?: ModelMetrics;
  plsIntercept?: number;
  coefficients?: number[];
  referenceSpectrum?: number[];
  unit?: string;
  modelType?: string;
  nComponents?: number;
  [key: string]: any;
}

export interface PredictionModel {
  id: string;
  name: string;
  product: string;
  json: ModelJSON;
}

export interface PredictionResult {
  property: string;
  value: number;
  unit: string;
}
