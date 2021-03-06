var babel = require('babel-core');
var content = `
var React = require('react');

type FooProps = {
  foo: ?string,
}

export default class Foo extends React.Component {
  props: FooProps
}
`;

it('nullable', () => {
  var res = babel.transform(content, {
    babelrc: false,
    presets: ['es2015', 'stage-1', 'react'],
    plugins: ['syntax-flow', require('../')],
  }).code;
  expect(res).toMatchSnapshot();
});
