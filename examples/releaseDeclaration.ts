import {
  AppActionEffectClass,
  AppActionExecutor,
  AppReleaseSchema,
  DeclarativeFieldCardinality,
  DeclarativeFieldKind,
  DeclarativeObjectCollectionKind,
  DeclarativeUiKind,
  create,
} from "../src/index.js";

export const releaseDeclaration = create(AppReleaseSchema, {
  actions: [{
    actionId: "select-items",
    effectClass: AppActionEffectClass.OBSERVE,
    executor: AppActionExecutor.APP,
    parameters: [{
      fieldId: "items",
      kind: DeclarativeFieldKind.OBJECT_REFERENCE,
      objectType: "item",
      cardinality: DeclarativeFieldCardinality.LIST,
      maxItems: 5,
    }, {
      fieldId: "mode",
      kind: DeclarativeFieldKind.CHOICE,
      choiceOptions: [
        { value: "compact", labelLocalizationKey: "mode.compact" },
        { value: "full", labelLocalizationKey: "mode.full" },
      ],
    }],
    objectBindings: [{
      objectType: "item",
      targetFieldId: "items",
      labelLocalizationKey: "action.select_this",
    }],
  }],
  primaryActionId: "select-items",
  uiContributions: [{
    contributionId: "item-card",
    kind: DeclarativeUiKind.OBJECT_CARD,
    objectType: "item",
    objectCollections: [{
      collectionId: "nearby-items",
      kind: DeclarativeObjectCollectionKind.NEARBY,
      objectType: "item",
      radiusMetres: 1000,
    }],
  }],
});
