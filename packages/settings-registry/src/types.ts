export type SettingsDomain = 'engine' | 'wiki' | 'chat' | 'curator' | 'vault';
export type ReloadClass = 'next-use' | 're-arm' | 'restart';

export type SettingType =
  | { kind: 'string'; nonEmpty?: boolean; nullable?: boolean }
  | { kind: 'text' }
  | { kind: 'int'; min?: number; max?: number; nullable?: boolean }
  | { kind: 'bool' }
  | { kind: 'enum'; values: readonly string[] }
  | { kind: 'string-list'; nullable?: boolean }
  | { kind: 'cron-or-empty' }
  | { kind: 'hhmm' }
  | { kind: 'timezone' }
  | { kind: 'duration' }
  | { kind: 'model-ref'; nullable?: boolean };

export interface SettingDescriptor {
  key: string;
  domain: SettingsDomain;
  type: SettingType;
  default: unknown;
  reload: ReloadClass;
  description: string;
  /** Env var this key seeds from on first boot; parse converts the raw string. */
  envSeed?: { var: string; parse?: (raw: string) => unknown };
}

export interface SettingIssue {
  key: string;
  code: 'SETTINGS_UNKNOWN_KEY' | 'SETTINGS_INVALID_VALUE' | 'SETTINGS_MODEL_REF_UNRESOLVED' | 'SETTINGS_NOT_IN_VAULT';
  message: string;
}
