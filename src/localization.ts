import type {
  AppActionDefinition,
  AppLocalization,
  AppRelease,
  DeclarativeUiContribution,
  DeclarativeUiField,
} from "./gen/qwibi/v1/app_release_pb.js";

/** Presentation projection of one immutable release action. */
export interface LocalizedReleaseAction {
  source: AppActionDefinition;
  title: string;
  description: string;
  fields: LocalizedReleaseField[];
}

/** Presentation projection of one immutable declarative field. */
export interface LocalizedReleaseField {
  source: DeclarativeUiField;
  label: string;
  /** Canonical action inputs; localization never changes submitted values. */
  choices: string[];
}

/** Presentation projection of one immutable declarative contribution. */
export interface LocalizedReleaseContribution {
  source: DeclarativeUiContribution;
  title: string;
}

/** Localized view derived solely from one explicitly supplied AppRelease. */
export interface LocalizedReleaseManifest {
  source: AppRelease;
  /** Canonical requested locale, or undefined when it was absent/invalid. */
  locale?: string;
  actions: LocalizedReleaseAction[];
  uiContributions: LocalizedReleaseContribution[];
}

/**
 * Builds a presentation-only view of one explicit immutable release.
 *
 * Resolution is field-by-field: exact BCP-47 tag, then its language subtag,
 * then the immutable localization key itself. Explicit empty strings win.
 */
export function localizeReleaseManifest(
  release: AppRelease,
  locale?: string | null,
): LocalizedReleaseManifest {
  const canonicalRequested = canonicalizeLocale(locale);
  const records = indexLocalizations(release.localizations);
  const candidates: AppLocalization[] = [];
  if (canonicalRequested) {
    const exact = records.get(canonicalRequested);
    if (exact) candidates.push(exact);
    const language = new Intl.Locale(canonicalRequested).language;
    if (language !== canonicalRequested) {
      const baseLanguage = records.get(language);
      if (baseLanguage) candidates.push(baseLanguage);
    }
  }
  const resolve = (key: string): string => localizeKey(key, candidates);

  return {
    source: release,
    ...(canonicalRequested ? { locale: canonicalRequested } : {}),
    actions: release.actions.map((action) => ({
      source: action,
      title: resolve(action.titleLocalizationKey),
      description: resolve(action.descriptionLocalizationKey),
      fields: action.parameters.map((field) => ({
        source: field,
        label: resolve(field.labelLocalizationKey),
        choices: field.choices,
      })),
    })),
    uiContributions: release.uiContributions.map((contribution) => ({
      source: contribution,
      title: resolve(contribution.titleLocalizationKey),
    })),
  };
}

function localizeKey(key: string, candidates: AppLocalization[]): string {
  for (const candidate of candidates) {
    if (Object.prototype.hasOwnProperty.call(candidate.entries, key)) {
      return candidate.entries[key]!;
    }
  }
  return key;
}

function indexLocalizations(localizations: AppLocalization[]): Map<string, AppLocalization> {
  const indexed = new Map<string, AppLocalization>();
  for (const localization of localizations) {
    const locale = canonicalizeLocale(localization.locale);
    if (!locale || indexed.has(locale)) continue;
    indexed.set(locale, localization);
  }
  return indexed;
}

function canonicalizeLocale(locale?: string | null): string | undefined {
  if (!locale) return undefined;
  try {
    return Intl.getCanonicalLocales(locale)[0];
  }
  catch {
    return undefined;
  }
}
