"""Read-only parser probe. All checkpoints and fixtures live beside this script."""
import ast
import hashlib
import json
import os
import logging
import sys
import time
import types
from collections import Counter
from dataclasses import asdict
from pathlib import Path
from typing import Optional

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
CORE = Path(os.environ.get('SM_CORE', '/Users/ruze/reg/my/SmartMemory/smart-memory-core'))
FORGE = Path(os.environ.get('FORGE_ROOT', '/Users/ruze/reg/my/forge'))
# Namespace loading avoids executing application and graph package initializers.
for name, directory in [('smartmemory', CORE / 'smartmemory'),
                        ('smartmemory.code', CORE / 'smartmemory/code')]:
    package = types.ModuleType(name)
    package.__path__ = [str(directory)]
    sys.modules[name] = package
from smartmemory.code.models import CodeEntity, CodeRelation, ImportSymbol
from smartmemory.code.ts_parser import TSParser

# Execute only the unchanged, pure SymbolTable and resolver method ASTs.
indexer_path = CORE / 'smartmemory/code/indexer.py'
tree = ast.parse(indexer_path.read_text())
symbol_class = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == 'SymbolTable')
indexer_class = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == 'CodeIndexer')
indexer_class.body = [n for n in indexer_class.body if isinstance(n, ast.FunctionDef)
                      and n.name in {'_build_symbol_table', '_resolve_cross_file_calls'}]
namespace = dict(globals(), logger=logging.getLogger('probe'))
exec(compile(ast.Module(body=[symbol_class, indexer_class], type_ignores=[]), str(indexer_path), 'exec'), namespace)
Resolver = namespace['CodeIndexer']
# Methods' globals must include the class used by _build_symbol_table.
Resolver._build_symbol_table.__globals__['SymbolTable'] = namespace['SymbolTable']

class ObservedParser(TSParser):
    """Observe the already parsed tree without parsing source twice."""
    def _walk(self, node, parent, rel_path, source, result, depth):
        if depth == 0 and node.type == 'program':
            self.raw_calls = []
            stack = [node]
            while stack:
                current = stack.pop()
                if current.type == 'call_expression':
                    fn = current.child_by_field_name('function')
                    self.raw_calls.append({'line': current.start_point[0] + 1,
                                           'callee': source[fn.start_byte:fn.end_byte].decode() if fn else ''})
                stack.extend(current.children)
        return super()._walk(node, parent, rel_path, source, result, depth)

def checkpoint(file, root, group):
    key = str(file.relative_to(root))
    cache = HERE / 'parsed' / group / (key + '.json')
    fingerprint = hashlib.sha256(file.read_bytes() + (CORE / 'smartmemory/code/ts_parser.py').read_bytes()).hexdigest()
    if cache.exists():
        previous = json.loads(cache.read_text())
        if previous['fingerprint'] == fingerprint and previous['result']['entities']:
            previous['reused'] = True
            return previous
    parser = ObservedParser(repo='forge-probe', repo_root=str(root))
    start = time.perf_counter()
    result = parser.parse_file(str(file))
    output = {'file': key, 'fingerprint': fingerprint, 'seconds': time.perf_counter() - start,
              'result': asdict(result), 'raw_calls': getattr(parser, 'raw_calls', []), 'reused': False}
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_text(json.dumps(output, indent=2) + '\n')
    return output

def summarize(rows):
    entities, relations, imports = [], [], []
    for row in rows:
        result = row['result']
        entities.extend(CodeEntity(**e) for e in result['entities'])
        relations.extend(CodeRelation(**r) for r in result['relations'])
        imports.extend(ImportSymbol(**i) for i in result['import_symbols'])
    resolver = Resolver()
    resolver.repo = 'forge-probe'
    symbols = resolver._build_symbol_table(entities, imports)
    resolved = resolver._resolve_cross_file_calls(relations, symbols)
    by_id = {e.item_id: e for e in entities}
    calls = [r for r in resolved if r.relation_type == 'CALLS']
    cross = [r for r in calls if r.target_id in by_id and r.source_id in by_id
             and by_id[r.target_id].file_path != by_id[r.source_id].file_path]
    raw_count = sum(len(row['raw_calls']) for row in rows)
    summary = {'files': len(rows), 'clean': sum(not r['result']['errors'] for r in rows),
               'failed_or_partial': [{ 'file': r['file'], 'errors': r['result']['errors']} for r in rows if r['result']['errors']],
               'parse_seconds': sum(r['seconds'] for r in rows), 'reused': sum(r['reused'] for r in rows),
               'entities_by_kind': dict(Counter(e.entity_type for e in entities)),
               'unique_entities': len(by_id), 'raw_call_sites': raw_count, 'extracted_calls': len(calls),
               'cross_file_resolved': len(cross), 'cross_fraction_extracted': len(cross)/len(calls) if calls else 0,
               'cross_fraction_all': len(cross)/raw_count if raw_count else 0,
               'symbols': symbols.size, 'import_symbols': len(imports)}
    return summary, [asdict(r) for r in resolved]

if __name__ == '__main__':
    files = sorted(FORGE.glob('compose/lib/*.js')) + sorted(FORGE.glob('stratum/ts/src/engine/*.ts')) + sorted(FORGE.glob('stratum/ts/src/ir/*.ts'))
    rows = [checkpoint(f, FORGE, 'forge') for f in files]
    groups = {'all': rows, 'compose': [r for r in rows if r['file'].startswith('compose/')],
              'stratum': [r for r in rows if r['file'].startswith('stratum/')]}
    summary = {}
    for group, selected in groups.items():
        summary[group], relations = summarize(selected)
        (HERE / f'{group}-resolved.json').write_text(json.dumps(relations, indent=2) + '\n')
    (HERE / 'measurement.json').write_text(json.dumps(summary, indent=2) + '\n')
    print(json.dumps(summary, indent=2))
