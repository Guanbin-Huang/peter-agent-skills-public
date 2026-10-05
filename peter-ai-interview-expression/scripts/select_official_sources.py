#!/usr/bin/env python3
"""Read-only substring selector for the bundled official-source registry."""
import argparse
import json
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--registry', type=Path, default=Path(__file__).resolve().parents[1] / 'references/official-company-sources.json')
parser.add_argument('--domain', choices=['agent', 'embodied'], required=True)
parser.add_argument('--kind', choices=['companies', 'materials'], default='companies')
parser.add_argument('--country', choices=['中国', '美国'])
parser.add_argument('--company', default='')
parser.add_argument('--query', default='')
parser.add_argument('--limit', type=int, default=5)
args = parser.parse_args()
if args.limit < 1:
    parser.error('--limit must be positive')
registry = json.loads(args.registry.read_text(encoding='utf-8'))
rows = registry['companies'] if args.kind == 'companies' else registry.get('tracked_materials', [])
selected = []
for row in rows:
    if args.domain and row['domain'] != args.domain:
        continue
    if args.country and row['country'] != args.country:
        continue
    if args.company.casefold() not in row['company'].casefold():
        continue
    fields = ['company', 'category', 'note', 'source_type'] if args.kind == 'companies' else ['company', 'title', 'source_type', 'technical_summary', 'project_application', 'limitations']
    haystack = ' '.join(str(row.get(k, '')) for k in fields).casefold()
    if args.query.casefold() not in haystack:
        continue
    selected.append(row)
output = {'registry': str(args.registry.resolve()), 'snapshot_updated_at': registry.get('updated_at', registry.get('created_at')), 'catalog_count': len(registry['companies']), 'matched_count': len(selected), 'returned_count': min(len(selected), args.limit), 'selection_method': 'substring_only_not_technical_verification'}
output['sources' if args.kind == 'companies' else 'materials'] = selected[:args.limit]
if args.kind == 'materials':
    output['material_count'] = len(rows)
print(json.dumps(output, ensure_ascii=False, indent=2))
