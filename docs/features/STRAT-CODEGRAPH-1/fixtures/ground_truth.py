"""Verify real source imports, definitions, call lines, then check saved relations."""
import importlib.metadata
import json
from collections import Counter
from pathlib import Path
from probe import HERE, FORGE

specs = [(f'compose/lib/{f}-writer.js', line, 'compose/lib/idempotency.js', 'checkOrInsert', 144)
         for f, line in [('journal',540),('judgment',1002),('followup',323),('feature',147),('changelog',327),('completion',265)]]
specs += [(f'compose/lib/{f}.js', line, 'compose/lib/pipeline-compat.js', 'tsCompatibilityOf',55)
          for f,line in [('build',3885),('new',101)]]
specs += [('stratum/ts/src/engine/engine.ts', line, f'stratum/ts/src/{target}', name, definition)
          for line,target,name,definition in [(561,'ir/validate.ts','validateSpec',348),
             (515,'engine/run_lock.ts','acquireRunLock',332),(921,'engine/receipts.ts','buildReceipt',26),
             (968,'engine/checkpoint.ts','commitCheckpoint',36),(1010,'engine/receipts.ts','spineSpent',67)]]
specs += [('stratum/ts/src/ir/validate.ts',447,'stratum/ts/src/ir/refs.ts','extractReferences',78),
          ('stratum/ts/src/engine/run_lock.ts',333,'stratum/ts/src/engine/state.ts','assertRunId',274)]
relations = json.loads((HERE/'all-resolved.json').read_text())
rows=[]
for file,line,target,name,definition in specs:
    source_lines=(FORGE/file).read_text().splitlines()
    target_lines=(FORGE/target).read_text().splitlines()
    assert name+'(' in source_lines[line-1], (file,line)
    assert name+'(' in target_lines[definition-1], (target,definition)
    imports=[f'{i+1}: {s}' for i,s in enumerate(source_lines) if s.startswith('import ') and name in s]
    assert imports, name
    edges=[r for r in relations if r['relation_type']=='CALLS' and r['source_id'].split('::')[2]==file
           and r['properties'].get('line')==line and r['properties'].get('callee')==name]
    found=any(r['target_id']==f'code::forge-probe::{target}::{name}' for r in edges)
    rows.append({'caller':f'{file}:{line}', 'callee':f'{target}:{definition}', 'symbol':name,
                 'found':found, 'extracted':bool(edges), 'call_source':source_lines[line-1],
                 'definition_source':target_lines[definition-1], 'imports':imports})
(HERE/'ground-truth.json').write_text(json.dumps(rows,indent=2)+'\n')
raw=Counter()
for file in (HERE/'parsed/forge').rglob('*.json'):
    saved=json.loads(file.read_text())
    raw.update((saved['file'],r['line'],r['callee']) for r in saved['raw_calls'])
cross=Counter((r['source_id'].split('::')[2],r['properties']['line'],r['properties']['callee'])
              for r in relations if r['relation_type']=='CALLS'
              and r['target_id'].split('::')[2]!=r['source_id'].split('::')[2])
print(json.dumps({'versions':{p:importlib.metadata.version(p) for p in ['tree-sitter','tree-sitter-typescript','tree-sitter-javascript']},
                  'matched_cross_raw_sites':sum((raw & cross).values()),
                  'ground_truth_found':sum(r['found'] for r in rows), 'rows':rows},indent=2))
