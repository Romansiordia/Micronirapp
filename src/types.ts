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
  derivative?: number;
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
  gh?: number;
}

export interface Sample {
  id: string | number;
  values: number[];
  color?: string;
  active?: boolean;
  analyticalValue: number;
}

export interface OptimizationResult {
  components: number;
  sec: number;
  secv: number;
}

export interface ModelResults {
  modelType: string;
  nComponents: number;
  model: any;
  mahalanobis: {
    distances: any[];
    outlierIds: (string | number)[];
  };
}

export interface IngredientLibrary {
  id: string;
  name: string;
  samples: { id: string | number; values: number[] }[];
  averageSpectrum: number[];
  stdDevSpectrum: number[];
  threshold: number;
}

export interface ClassificationResult {
  ingredientId: string;
  ingredientName: string;
  confidence: number;
  distance: number;
  isConforming: boolean;
  details: {
    meanDistance: number;
    threshold: number;
  };
}
