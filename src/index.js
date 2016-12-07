import {
  $debug,
  getExportNameForType,
  containsReactElement,
  PLUGIN_NAME,
  hasReactElementTypeAnnotationReturn,
} from './util';
import convertToPropTypes from './convertToPropTypes';
import makePropTypesAst from './makePropTypesAst';

// maps between type alias name to prop types
let internalTypes = {};

// maps between type alias to import alias
let importedTypes = {};
let suppress = false;
const SUPPRESS_STRING = 'no babel-plugin-flow-react-proptypes';

const convertNodeToPropTypes = node => convertToPropTypes(
    node,
    importedTypes,
    internalTypes
);

const getPropsForTypeAnnotation = typeAnnotation => {
  const typeAnnotationReference = typeAnnotation.id && typeAnnotation.id.name;

  let props = null;
  if (typeAnnotationReference) {
    props = internalTypes[typeAnnotationReference] || importedTypes[typeAnnotationReference];
    if (!props) {
      $debug(`Did not find type annotation for reference ${typeAnnotationReference}`);
    }
  }
  else if (typeAnnotation.properties || typeAnnotation.type || 'GenericTypeAnnotation') {
    props = convertNodeToPropTypes(typeAnnotation);
  }
  else {
    throw new Error(`Expected prop types, but found none. This is a bug in ${PLUGIN_NAME}`);
  }

  return props;
};

const getFunctionalComponentTypeProps = path => {
  // Check if this looks like a stateless react component with PropType reference:
  const firstParam = path.node.params[0];
  const typeAnnotation = firstParam
    && firstParam.typeAnnotation
    && firstParam.typeAnnotation.typeAnnotation;

  if (!typeAnnotation) {
    $debug('Found stateless component without type definition');
    return;
  }

  return getPropsForTypeAnnotation(typeAnnotation);
};

module.exports = function flowReactPropTypes(babel) {
  const t = babel.types;

  const isFunctionalReactComponent = path => {
    if ((path.type === 'ArrowFunctionExpression' || path.type === 'FunctionExpression') && !path.parent.id) {
      // Could be functions inside a React component
      return false;
    }
    if (hasReactElementTypeAnnotationReturn(path.node)) {
      return true;
    }
    if (containsReactElement(path.node)) {
      return true;
    }
    return false;
  };

  const annotate = (path, props) => {
    let name;
    let targetPath;


    if (path.type === 'ArrowFunctionExpression' || path.type === 'FunctionExpression') {
      name = path.parent.id.name;
      const basePath = path.parentPath.parentPath;
      targetPath = t.isExportDeclaration(basePath.parent) ? basePath.parentPath : basePath;
    }
    else {
      name = path.node.id.name;
      targetPath = path.parent.type === 'Program' ? path : path.parentPath;
    }

    if (!props) {
      throw new Error(`Did not find type annotation for ${name}`);
    }

    if (typeof props !== 'string' && !props.properties) {
      // Bail out if we aren't an imported type and don't have properties.
      // This will be the case for an 'any' type annotation, like:
      // const C = (props: any) => <div>{props.name}</div>;
      return;
    }

    const propTypesAST = makePropTypesAst(props);
    const attachPropTypesAST = t.expressionStatement(
      t.assignmentExpression(
        '=',
        t.memberExpression(t.identifier(name), t.identifier('propTypes')),
        propTypesAST
      )
    );
    targetPath.insertAfter(attachPropTypesAST);
  };

  const functionVisitor = path => {
    if (!isFunctionalReactComponent(path)) {
      return;
    }
    const props = getFunctionalComponentTypeProps(path);
    if (props) {
      annotate(path, props);
    }
  };

  return {
    visitor: {
      Program(path) {
        internalTypes = {};
        importedTypes = {};
        suppress = false;
        const directives = path.node.directives;
        if(directives && directives.length)  {
          const directive = directives[0];
          if (directive.value && directive.value.value == SUPPRESS_STRING) {
            suppress = true;
          }
        }
      },
      TypeAlias(path) {
        if (suppress) return;
        $debug('TypeAlias found');
        const {right} = path.node;

        const typeAliasName = path.node.id.name;
        if (!typeAliasName) {
          throw new Error('Did not find name for type alias');
        }

        const propTypes = convertNodeToPropTypes(right);
        internalTypes[typeAliasName] = propTypes;
      },
      ClassDeclaration(path) {
        if (suppress) return;
        const {superClass} = path.node;

        // check if we're extending React.Compoennt
        const extendsReactComponent = superClass && superClass.type === 'MemberExpression'
        && superClass.object.name === 'React'
        && (superClass.property.name === 'Component' || superClass.property.name === 'PureComponent');
        const extendsComponent = superClass
                                 && superClass.type === 'Identifier'
                                 && (superClass.name === 'Component' || superClass.name === 'PureComponent');
        if (!extendsReactComponent && !extendsComponent) {
          $debug('Found a class that isn\'t a react component', superClass);
          return;
        }

        // And have type as property annotations or Component<void, Props, void>
        path.node.body.body.forEach(bodyNode => {
          if (bodyNode && bodyNode.key.name === 'props' && bodyNode.typeAnnotation) {
            const props = getPropsForTypeAnnotation(bodyNode.typeAnnotation.typeAnnotation);
            return annotate(path, props);
          }
        });

        // super type parameter
        const secondSuperParam = path.node.superTypeParameters && path.node.superTypeParameters.params[1];
        if (secondSuperParam && secondSuperParam.type === 'GenericTypeAnnotation') {
          const typeAliasName = secondSuperParam.id.name;
          const props = internalTypes[typeAliasName];
          return annotate(path, props);
        }
      },

      FunctionExpression(path) {
        if (suppress) return;
        return functionVisitor(path);
      },

      FunctionDeclaration(path) {
        if (suppress) return;
        return functionVisitor(path);
      },

      ArrowFunctionExpression(path) {
        if (suppress) return;
        return functionVisitor(path);
      },

      // See issue:
      ExportNamedDeclaration(path) {
        if (suppress) return;
        const {node} = path;

        if (!node.declaration || node.declaration.type !== 'TypeAlias') {
          return;
        }
        if (!node.declaration.right.properties) {
          return;
        }

        const name = node.declaration.id.name;
        const propTypes = convertNodeToPropTypes(node.declaration.right);
        internalTypes[name] = propTypes;

        let propTypesAst = makePropTypesAst(propTypes);

        if (propTypesAst.type === 'ObjectExpression') {
          propTypesAst = t.callExpression(
            t.memberExpression(
              t.memberExpression(
                t.callExpression(
                  t.identifier('require'),
                  [t.stringLiteral('react')]
                ),
                t.identifier('PropTypes')
              ),
              t.identifier('shape'),
            ),
            [propTypesAst],
          );
        }

        const exportAst = t.expressionStatement(t.callExpression(
          t.memberExpression(t.identifier('Object'), t.identifier('defineProperty')),
          [
            t.memberExpression(t.identifier('module'), t.identifier('exports')),
            t.stringLiteral(getExportNameForType(name)),
            t.objectExpression([t.objectProperty(t.identifier('value'), propTypesAst)]),
          ]
        ));
        path.insertAfter(exportAst);
      },
      ImportDeclaration(path) {
        if (suppress) return;
        const {node} = path;
        if (node.importKind === 'type') {
          node.specifiers.forEach((specifier) => {
            const typeName = specifier.type === 'ImportDefaultSpecifier'
              ? specifier.local.name
              : specifier.imported.name;

            importedTypes[typeName] = getExportNameForType(typeName);
            const variableDeclarationAst = t.variableDeclaration(
              'var',
              [
                t.variableDeclarator(
                  // TODO: use local import name?
                  t.identifier(getExportNameForType(typeName)),
                  t.logicalExpression(
                    '||',
                    t.memberExpression(
                      t.callExpression(
                        t.identifier('require'),
                        [t.stringLiteral(node.source.value)]
                      ),
                      t.identifier(getExportNameForType(typeName))
                    ),
                    t.memberExpression(
                      t.memberExpression(
                        t.callExpression(
                          t.identifier('require'),
                          [
                            t.stringLiteral('react'),
                          ]
                        ),
                        t.identifier('PropTypes')
                      ),
                      t.identifier('any')
                    )
                  ),
                )
              ]
            );
            path.insertAfter(variableDeclarationAst);
          });
        }
      }
    }
  };
};
