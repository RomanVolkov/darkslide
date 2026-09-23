import type { Adjustments } from "../backend/types.ts";

export type AdjustmentKey =
    | "exposure"
    | "contrast"
    | "highlights"
    | "shadows"
    | "whites"
    | "blacks"
    | "brightness"
    | "temperature"
    | "tint"
    | "hue"
    | "saturation"
    | "vibrance"
    | "texture"
    | "clarity"
    | "black_point"
    | "sharpen_amount"
    | "sharpen_radius"
    | "grain_amount"
    | "grain_size"
    | "grain_roughness"
    | "denoise_strength"
    | "denoise_preserve"
    | "straighten"
    | "zoom"
    | "crop_x"
    | "crop_y"
    | "distortion"
    | "perspective_v"
    | "perspective_h"
    | "lut_intensity";

export type ImageID = string;

export interface ImageEntry {
    id: ImageID;
    filename: string;
    adjustments: Adjustments;
}

export interface SessionSummary {
    id: number;
    name: string;
    image_count: number;
    updated_at: string;
}

export interface CreateSessionResult {
    id: number;
    name: string;
    is_existing: boolean;
}
