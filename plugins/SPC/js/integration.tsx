import React from 'react';
import { StyleSheet, View } from 'react-native';
import { getModules } from '@valenced/modules/finders';
import { createFilterGenerator, FilterScopes } from '@valenced/modules/finders/filters';
import { Player } from './player';

const nameOf = (type: any): string => type?.displayName || type?.name || '';
const filter = createFilterGenerator<[string]>(
  ([name], _id, value: any) => [value, value?.default, value?.type, value?.default?.type, value?.render, value?.default?.render].some(v => nameOf(v) === name),
  ([name]) => 'dariuss.spotify.component(' + name + ')', FilterScopes.Initialized,
);
class Guard extends React.Component<{ original: React.ReactNode; children?: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? this.props.original : this.props.children; }
}
const barWrappers = new WeakMap<object, any>();
function measureTree(tree: any, measure: (height: number) => void, depth = 0): any {
  if (depth > 16 || !tree) return tree;
  if (Array.isArray(tree)) return tree.map(node => measureTree(node, measure, depth + 1));
  if (!React.isValidElement<any>(tree)) return tree;
  const type: any = tree.type, original = type?.type ?? type;
  if (typeof original === 'function' && nameOf(original) === 'YouBar') {
    let Wrapped = barWrappers.get(type);
    if (!Wrapped) {
      Wrapped = function SpotifyMeasuredBar({ spcMeasure, ...props }: any) {
        const result = original(props);
        if (!React.isValidElement<any>(result)) return result;
        return React.cloneElement(result, { onLayout: (event: any) => {
          const style = StyleSheet.flatten(result.props.style) || {};
          spcMeasure(event.nativeEvent.layout.height + (typeof style.marginBottom === 'number' ? Math.max(0, style.marginBottom) : 0));
          result.props.onLayout?.(event);
        } });
      };
      barWrappers.set(type, Wrapped);
    }
    return React.createElement(Wrapped, { ...tree.props, key: tree.key, spcMeasure: measure });
  }
  return tree.props.children ? React.cloneElement(tree, {}, measureTree(tree.props.children, measure, depth + 1)) : tree;
}
function Dock({ original }: { original: React.ReactNode }) {
  const [height, setHeight] = React.useState(0);
  const measure = React.useCallback((value: number) => setHeight(previous => Math.abs(previous - value) > 1 ? value : previous), []);
  return <View style={{ position: 'absolute', bottom: 0, left: 0, right: 0, paddingBottom: height + 12 }}>
    <Player />{measureTree(original, measure)}
  </View>;
}
export function startIntegration(report: (error: unknown) => void) {
  let active = true;
  const seen = new WeakSet<object>(), undo: (() => void)[] = [];
  const attach = (mod: any) => {
    const component = mod?.default ?? mod;
    const owner = typeof component?.type === 'function' || typeof component?.render === 'function' ? component : mod;
    const key = typeof component?.type === 'function' ? 'type' : typeof component?.render === 'function' ? 'render' : 'default';
    if (!owner || typeof owner[key] !== 'function' || seen.has(owner)) return;
    seen.add(owner);
    const original = owner[key];
    const wrapped = function (this: unknown, ...args: any[]) {
      const tree = Reflect.apply(original, this, args) as React.ReactNode;
      if (!active) return tree;
      return <Guard original={tree}><Dock original={tree} /></Guard>;
    };
    try { owner[key] = wrapped; undo.push(() => { if (owner[key] === wrapped) owner[key] = original; }); }
    catch (error) { report(error); }
  };
  // YouBarThemed is the exported owner; hook once to avoid duplicate nested cards.
  undo.push(getModules(filter('YouBarThemed'), attach, { returnNamespace: true }));
  return () => { active = false; for (const fn of undo.reverse()) fn(); };
}
