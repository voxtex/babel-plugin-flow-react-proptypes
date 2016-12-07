var babel = require('babel-core');
var content = `
// @flow
var React = require('react');
import type { ExternalType } from '../types';

export default class Foo extends React.Component {
  props: {
    a_number: number,
    external: ExternalType,
  }

  render () {
    return <div />
  }
}

export class UnboxedFoo extends React.Component {
  props: ExternalType

  render () {
    return <div />
  }
}
`;

it('class-inline-props', () => {
  var res = babel.transform(content, {
    babelrc: false,
    presets: ['es2015', 'stage-1', 'react'],
    plugins: ['syntax-flow', require('../')],
  }).code;
  expect(res).toMatchSnapshot();
});
