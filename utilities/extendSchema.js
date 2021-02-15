import { objectValues } from "../polyfills/objectValues.js";
import { keyMap } from "../jsutils/keyMap.js";
import { inspect } from "../jsutils/inspect.js";
import { mapValue } from "../jsutils/mapValue.js";
import { invariant } from "../jsutils/invariant.js";
import { devAssert } from "../jsutils/devAssert.js";
import { Kind } from "../language/kinds.js";
import { isTypeDefinitionNode, isTypeExtensionNode } from "../language/predicates.js";
import { assertValidSDLExtension } from "../validation/validate.js";
import { getDirectiveValues } from "../execution/values.js";
import { assertSchema, GraphQLSchema } from "../type/schema.js";
import { specifiedScalarTypes, isSpecifiedScalarType } from "../type/scalars.js";
import { introspectionTypes, isIntrospectionType } from "../type/introspection.js";
import { GraphQLDirective, GraphQLDeprecatedDirective, GraphQLSpecifiedByDirective } from "../type/directives.js";
import { isScalarType, isObjectType, isInterfaceType, isUnionType, isListType, isNonNullType, isEnumType, isInputObjectType, GraphQLList, GraphQLNonNull, GraphQLScalarType, GraphQLObjectType, GraphQLInterfaceType, GraphQLUnionType, GraphQLEnumType, GraphQLInputObjectType } from "../type/definition.js";
import { valueFromAST } from "./valueFromAST.js";

/**
 * Produces a new schema given an existing schema and a document which may
 * contain GraphQL type extensions and definitions. The original schema will
 * remain unaltered.
 *
 * Because a schema represents a graph of references, a schema cannot be
 * extended without effectively making an entire copy. We do not know until it's
 * too late if subgraphs remain unchanged.
 *
 * This algorithm copies the provided schema, applying extensions while
 * producing the copy. The original schema remains unaltered.
 */
export function extendSchema(schema, documentAST, options) {
  assertSchema(schema);
  documentAST != null && documentAST.kind === Kind.DOCUMENT || devAssert(0, 'Must provide valid Document AST.');

  if (options?.assumeValid !== true && options?.assumeValidSDL !== true) {
    assertValidSDLExtension(documentAST, schema);
  }

  const schemaConfig = schema.toConfig();
  const extendedConfig = extendSchemaImpl(schemaConfig, documentAST, options);
  return schemaConfig === extendedConfig ? schema : new GraphQLSchema(extendedConfig);
}
/**
 * @internal
 */

export function extendSchemaImpl(schemaConfig, documentAST, options) {
  // Collect the type definitions and extensions found in the document.
  const typeDefs = [];
  const typeExtensionsMap = Object.create(null); // New directives and types are separate because a directives and types can
  // have the same name. For example, a type named "skip".

  const directiveDefs = [];
  let schemaDef; // Schema extensions are collected which may add additional operation types.

  const schemaExtensions = [];

  for (const def of documentAST.definitions) {
    if (def.kind === Kind.SCHEMA_DEFINITION) {
      schemaDef = def;
    } else if (def.kind === Kind.SCHEMA_EXTENSION) {
      schemaExtensions.push(def);
    } else if (isTypeDefinitionNode(def)) {
      typeDefs.push(def);
    } else if (isTypeExtensionNode(def)) {
      const extendedTypeName = def.name.value;
      const existingTypeExtensions = typeExtensionsMap[extendedTypeName];
      typeExtensionsMap[extendedTypeName] = existingTypeExtensions ? existingTypeExtensions.concat([def]) : [def];
    } else if (def.kind === Kind.DIRECTIVE_DEFINITION) {
      directiveDefs.push(def);
    }
  } // If this document contains no new types, extensions, or directives then
  // return the same unmodified GraphQLSchema instance.


  if (Object.keys(typeExtensionsMap).length === 0 && typeDefs.length === 0 && directiveDefs.length === 0 && schemaExtensions.length === 0 && schemaDef == null) {
    return schemaConfig;
  }

  const typeMap = Object.create(null);

  for (const existingType of schemaConfig.types) {
    typeMap[existingType.name] = extendNamedType(existingType);
  }

  for (const typeNode of typeDefs) {
    const name = typeNode.name.value;
    typeMap[name] = stdTypeMap[name] ?? buildType(typeNode);
  }

  const operationTypes = {
    // Get the extended root operation types.
    query: schemaConfig.query && replaceNamedType(schemaConfig.query),
    mutation: schemaConfig.mutation && replaceNamedType(schemaConfig.mutation),
    subscription: schemaConfig.subscription && replaceNamedType(schemaConfig.subscription),
    // Then, incorporate schema definition and all schema extensions.
    ...(schemaDef && getOperationTypes([schemaDef])),
    ...getOperationTypes(schemaExtensions)
  }; // Then produce and return a Schema config with these types.

  return {
    description: schemaDef?.description?.value,
    ...operationTypes,
    types: objectValues(typeMap),
    directives: [...schemaConfig.directives.map(replaceDirective), ...directiveDefs.map(buildDirective)],
    extensions: undefined,
    astNode: schemaDef ?? schemaConfig.astNode,
    extensionASTNodes: schemaConfig.extensionASTNodes.concat(schemaExtensions),
    assumeValid: options?.assumeValid ?? false
  }; // Below are functions used for producing this schema that have closed over
  // this scope and have access to the schema, cache, and newly defined types.

  function replaceType(type) {
    if (isListType(type)) {
      // $FlowFixMe[incompatible-return]
      return new GraphQLList(replaceType(type.ofType));
    }

    if (isNonNullType(type)) {
      // $FlowFixMe[incompatible-return]
      return new GraphQLNonNull(replaceType(type.ofType));
    }

    return replaceNamedType(type);
  }

  function replaceNamedType(type) {
    // Note: While this could make early assertions to get the correctly
    // typed values, that would throw immediately while type system
    // validation with validateSchema() will produce more actionable results.
    return typeMap[type.name];
  }

  function replaceDirective(directive) {
    const config = directive.toConfig();
    return new GraphQLDirective({ ...config,
      args: mapValue(config.args, extendArg)
    });
  }

  function extendNamedType(type) {
    if (isIntrospectionType(type) || isSpecifiedScalarType(type)) {
      // Builtin types are not extended.
      return type;
    }

    if (isScalarType(type)) {
      return extendScalarType(type);
    }

    if (isObjectType(type)) {
      return extendObjectType(type);
    }

    if (isInterfaceType(type)) {
      return extendInterfaceType(type);
    }

    if (isUnionType(type)) {
      return extendUnionType(type);
    }

    if (isEnumType(type)) {
      return extendEnumType(type);
    } // istanbul ignore else (See: 'https://github.com/graphql/graphql-js/issues/2618')


    if (isInputObjectType(type)) {
      return extendInputObjectType(type);
    } // istanbul ignore next (Not reachable. All possible types have been considered)


    false || invariant(0, 'Unexpected type: ' + inspect(type));
  }

  function extendInputObjectType(type) {
    const config = type.toConfig();
    const extensions = typeExtensionsMap[config.name] ?? [];
    return new GraphQLInputObjectType({ ...config,
      fields: () => ({ ...mapValue(config.fields, field => ({ ...field,
          type: replaceType(field.type)
        })),
        ...buildInputFieldMap(extensions)
      }),
      extensionASTNodes: config.extensionASTNodes.concat(extensions)
    });
  }

  function extendEnumType(type) {
    const config = type.toConfig();
    const extensions = typeExtensionsMap[type.name] ?? [];
    return new GraphQLEnumType({ ...config,
      values: { ...config.values,
        ...buildEnumValueMap(extensions)
      },
      extensionASTNodes: config.extensionASTNodes.concat(extensions)
    });
  }

  function extendScalarType(type) {
    const config = type.toConfig();
    const extensions = typeExtensionsMap[config.name] ?? [];
    let specifiedByUrl = config.specifiedByUrl;

    for (const extensionNode of extensions) {
      specifiedByUrl = getSpecifiedByUrl(extensionNode) ?? specifiedByUrl;
    }

    return new GraphQLScalarType({ ...config,
      specifiedByUrl,
      extensionASTNodes: config.extensionASTNodes.concat(extensions)
    });
  }

  function extendObjectType(type) {
    const config = type.toConfig();
    const extensions = typeExtensionsMap[config.name] ?? [];
    return new GraphQLObjectType({ ...config,
      interfaces: () => [...type.getInterfaces().map(replaceNamedType), ...buildInterfaces(extensions)],
      fields: () => ({ ...mapValue(config.fields, extendField),
        ...buildFieldMap(extensions)
      }),
      extensionASTNodes: config.extensionASTNodes.concat(extensions)
    });
  }

  function extendInterfaceType(type) {
    const config = type.toConfig();
    const extensions = typeExtensionsMap[config.name] ?? [];
    return new GraphQLInterfaceType({ ...config,
      interfaces: () => [...type.getInterfaces().map(replaceNamedType), ...buildInterfaces(extensions)],
      fields: () => ({ ...mapValue(config.fields, extendField),
        ...buildFieldMap(extensions)
      }),
      extensionASTNodes: config.extensionASTNodes.concat(extensions)
    });
  }

  function extendUnionType(type) {
    const config = type.toConfig();
    const extensions = typeExtensionsMap[config.name] ?? [];
    return new GraphQLUnionType({ ...config,
      types: () => [...type.getTypes().map(replaceNamedType), ...buildUnionTypes(extensions)],
      extensionASTNodes: config.extensionASTNodes.concat(extensions)
    });
  }

  function extendField(field) {
    return { ...field,
      type: replaceType(field.type),
      // $FlowFixMe[incompatible-call]
      args: mapValue(field.args, extendArg)
    };
  }

  function extendArg(arg) {
    return { ...arg,
      type: replaceType(arg.type)
    };
  }

  function getOperationTypes(nodes) {
    const opTypes = {};

    for (const node of nodes) {
      // istanbul ignore next (See: 'https://github.com/graphql/graphql-js/issues/2203')
      const operationTypesNodes = node.operationTypes ?? [];

      for (const operationType of operationTypesNodes) {
        opTypes[operationType.operation] = getNamedType(operationType.type);
      }
    } // Note: While this could make early assertions to get the correctly
    // typed values below, that would throw immediately while type system
    // validation with validateSchema() will produce more actionable results.


    return opTypes;
  }

  function getNamedType(node) {
    const name = node.name.value;
    const type = stdTypeMap[name] ?? typeMap[name];

    if (type === undefined) {
      throw new Error(`Unknown type: "${name}".`);
    }

    return type;
  }

  function getWrappedType(node) {
    if (node.kind === Kind.LIST_TYPE) {
      return new GraphQLList(getWrappedType(node.type));
    }

    if (node.kind === Kind.NON_NULL_TYPE) {
      // $FlowFixMe[incompatible-call]
      return new GraphQLNonNull(getWrappedType(node.type));
    }

    return getNamedType(node);
  }

  function buildDirective(node) {
    const locations = node.locations.map(({
      value
    }) => value);
    return new GraphQLDirective({
      name: node.name.value,
      description: node.description?.value,
      locations,
      isRepeatable: node.repeatable,
      args: buildArgumentMap(node.arguments),
      astNode: node
    });
  }

  function buildFieldMap(nodes) {
    const fieldConfigMap = Object.create(null);

    for (const node of nodes) {
      // istanbul ignore next (See: 'https://github.com/graphql/graphql-js/issues/2203')
      const nodeFields = node.fields ?? [];

      for (const field of nodeFields) {
        fieldConfigMap[field.name.value] = {
          // Note: While this could make assertions to get the correctly typed
          // value, that would throw immediately while type system validation
          // with validateSchema() will produce more actionable results.
          type: getWrappedType(field.type),
          description: field.description?.value,
          args: buildArgumentMap(field.arguments),
          deprecationReason: getDeprecationReason(field),
          astNode: field
        };
      }
    }

    return fieldConfigMap;
  }

  function buildArgumentMap(args) {
    // istanbul ignore next (See: 'https://github.com/graphql/graphql-js/issues/2203')
    const argsNodes = args ?? [];
    const argConfigMap = Object.create(null);

    for (const arg of argsNodes) {
      // Note: While this could make assertions to get the correctly typed
      // value, that would throw immediately while type system validation
      // with validateSchema() will produce more actionable results.
      const type = getWrappedType(arg.type);
      argConfigMap[arg.name.value] = {
        type,
        description: arg.description?.value,
        defaultValue: valueFromAST(arg.defaultValue, type),
        deprecationReason: getDeprecationReason(arg),
        astNode: arg
      };
    }

    return argConfigMap;
  }

  function buildInputFieldMap(nodes) {
    const inputFieldMap = Object.create(null);

    for (const node of nodes) {
      // istanbul ignore next (See: 'https://github.com/graphql/graphql-js/issues/2203')
      const fieldsNodes = node.fields ?? [];

      for (const field of fieldsNodes) {
        // Note: While this could make assertions to get the correctly typed
        // value, that would throw immediately while type system validation
        // with validateSchema() will produce more actionable results.
        const type = getWrappedType(field.type);
        inputFieldMap[field.name.value] = {
          type,
          description: field.description?.value,
          defaultValue: valueFromAST(field.defaultValue, type),
          deprecationReason: getDeprecationReason(field),
          astNode: field
        };
      }
    }

    return inputFieldMap;
  }

  function buildEnumValueMap(nodes) {
    const enumValueMap = Object.create(null);

    for (const node of nodes) {
      // istanbul ignore next (See: 'https://github.com/graphql/graphql-js/issues/2203')
      const valuesNodes = node.values ?? [];

      for (const value of valuesNodes) {
        enumValueMap[value.name.value] = {
          description: value.description?.value,
          deprecationReason: getDeprecationReason(value),
          astNode: value
        };
      }
    }

    return enumValueMap;
  }

  function buildInterfaces(nodes) {
    const interfaces = [];

    for (const node of nodes) {
      // istanbul ignore next (See: 'https://github.com/graphql/graphql-js/issues/2203')
      const interfacesNodes = node.interfaces ?? [];

      for (const type of interfacesNodes) {
        // Note: While this could make assertions to get the correctly typed
        // values below, that would throw immediately while type system
        // validation with validateSchema() will produce more actionable
        // results.
        interfaces.push(getNamedType(type));
      }
    }

    return interfaces;
  }

  function buildUnionTypes(nodes) {
    const types = [];

    for (const node of nodes) {
      // istanbul ignore next (See: 'https://github.com/graphql/graphql-js/issues/2203')
      const typeNodes = node.types ?? [];

      for (const type of typeNodes) {
        // Note: While this could make assertions to get the correctly typed
        // values below, that would throw immediately while type system
        // validation with validateSchema() will produce more actionable
        // results.
        types.push(getNamedType(type));
      }
    }

    return types;
  }

  function buildType(astNode) {
    const name = astNode.name.value;
    const extensionNodes = typeExtensionsMap[name] ?? [];

    switch (astNode.kind) {
      case Kind.OBJECT_TYPE_DEFINITION:
        {
          const extensionASTNodes = extensionNodes;
          const allNodes = [astNode, ...extensionASTNodes];
          return new GraphQLObjectType({
            name,
            description: astNode.description?.value,
            interfaces: () => buildInterfaces(allNodes),
            fields: () => buildFieldMap(allNodes),
            astNode,
            extensionASTNodes
          });
        }

      case Kind.INTERFACE_TYPE_DEFINITION:
        {
          const extensionASTNodes = extensionNodes;
          const allNodes = [astNode, ...extensionASTNodes];
          return new GraphQLInterfaceType({
            name,
            description: astNode.description?.value,
            interfaces: () => buildInterfaces(allNodes),
            fields: () => buildFieldMap(allNodes),
            astNode,
            extensionASTNodes
          });
        }

      case Kind.ENUM_TYPE_DEFINITION:
        {
          const extensionASTNodes = extensionNodes;
          const allNodes = [astNode, ...extensionASTNodes];
          return new GraphQLEnumType({
            name,
            description: astNode.description?.value,
            values: buildEnumValueMap(allNodes),
            astNode,
            extensionASTNodes
          });
        }

      case Kind.UNION_TYPE_DEFINITION:
        {
          const extensionASTNodes = extensionNodes;
          const allNodes = [astNode, ...extensionASTNodes];
          return new GraphQLUnionType({
            name,
            description: astNode.description?.value,
            types: () => buildUnionTypes(allNodes),
            astNode,
            extensionASTNodes
          });
        }

      case Kind.SCALAR_TYPE_DEFINITION:
        {
          const extensionASTNodes = extensionNodes;
          return new GraphQLScalarType({
            name,
            description: astNode.description?.value,
            specifiedByUrl: getSpecifiedByUrl(astNode),
            astNode,
            extensionASTNodes
          });
        }

      case Kind.INPUT_OBJECT_TYPE_DEFINITION:
        {
          const extensionASTNodes = extensionNodes;
          const allNodes = [astNode, ...extensionASTNodes];
          return new GraphQLInputObjectType({
            name,
            description: astNode.description?.value,
            fields: () => buildInputFieldMap(allNodes),
            astNode,
            extensionASTNodes
          });
        }
    } // istanbul ignore next (Not reachable. All possible type definition nodes have been considered)


    false || invariant(0, 'Unexpected type definition node: ' + inspect(astNode));
  }
}
const stdTypeMap = keyMap(specifiedScalarTypes.concat(introspectionTypes), type => type.name);
/**
 * Given a field or enum value node, returns the string value for the
 * deprecation reason.
 */

function getDeprecationReason(node) {
  const deprecated = getDirectiveValues(GraphQLDeprecatedDirective, node);
  return deprecated?.reason;
}
/**
 * Given a scalar node, returns the string value for the specifiedByUrl.
 */


function getSpecifiedByUrl(node) {
  const specifiedBy = getDirectiveValues(GraphQLSpecifiedByDirective, node);
  return specifiedBy?.url;
}
