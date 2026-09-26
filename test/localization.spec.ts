import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
  AppActionEffectClass,
  AppActionExecutor,
  AppReleaseSchema,
  DeclarativeFieldKind,
  DeclarativeUiFieldSchema,
  DeclarativeUiKind,
  localizeReleaseManifest,
} from "../src/index.js";

function localizedRelease() {
  const release = create(AppReleaseSchema, {
    releaseId: "019d0000-0000-7000-8000-000000000002",
    appId: "019d0000-0000-7000-8000-000000000001",
    semanticVersion: "1.2.3",
    actions: [{
      actionId: "route",
      effectClass: AppActionEffectClass.OBSERVE,
      executor: AppActionExecutor.APP,
      titleLocalizationKey: "route.title",
      descriptionLocalizationKey: "route.description",
      parameters: [create(DeclarativeUiFieldSchema, {
        fieldId: "class", kind: DeclarativeFieldKind.CHOICE,
        labelLocalizationKey: "route.class.label", choices: ["economy", "comfort"],
      })],
    }],
    uiContributions: [{
      contributionId: "object-card",
      kind: DeclarativeUiKind.OBJECT_CARD,
      titleLocalizationKey: "card.title",
    }],
    localizations: [
      {
        locale: "pt",
        entries: {
          "route.title": "Rota",
          "route.description": "Criar uma rota",
          "card.title": "Objeto",
          "route.class.label": "Classe",
        },
      },
      {
        locale: "pt-BR",
        entries: {
          "route.title": "Rota brasileira",
          "route.description": "",
        },
      },
    ],
  });
  return release;
}

describe("localizeReleaseManifest", () => {
  it("resolves immutable release keys by exact tag, then language", () => {
    const release = localizedRelease();
    const localized = localizeReleaseManifest(release, "PT-br");
    const action = localized.actions[0]!;
    const contribution = localized.uiContributions[0]!;
    const field = action.fields[0]!;

    expect(localized.locale).toBe("pt-BR");
    expect(action.title).toBe("Rota brasileira");
    expect(action.description).toBe("");
    expect(contribution.title).toBe("Objeto");
    expect(field.label).toBe("Classe");
    expect(field.choices).toEqual(["economy", "comfort"]);
  });

  it("uses localization keys as safe fallbacks when the explicit release has no match", () => {
    const release = localizedRelease();
    const portuguese = localizeReleaseManifest(release, "pt-PT").actions[0]!;
    expect(portuguese.title).toBe("Rota");

    const french = localizeReleaseManifest(release, "fr-FR");
    expect(french.actions[0]!.title).toBe("route.title");
    expect(french.actions[0]!.fields[0]!.label).toBe("route.class.label");
  });

  it("retains the exact release sources and never translates canonical choice values", () => {
    const release = localizedRelease();
    const localized = localizeReleaseManifest(release, "pt-BR");

    expect(localized.source).toBe(release);
    expect(localized.actions[0]!.source).toBe(release.actions[0]);
    expect(localized.uiContributions[0]!.source).toBe(release.uiContributions[0]);
    expect(localized.actions[0]!.fields[0]!.source).toBe(release.actions[0]!.parameters[0]);
    expect(localized.actions[0]!.fields[0]!.choices).toEqual(["economy", "comfort"]);
  });

  it("falls back safely for an invalid requested locale", () => {
    const localized = localizeReleaseManifest(localizedRelease(), "not_a_locale");
    expect(localized.locale).toBeUndefined();
    expect(localized.actions[0]!.title).toBe("route.title");
  });
});
