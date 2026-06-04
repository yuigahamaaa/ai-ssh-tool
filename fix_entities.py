#!/usr/bin/env python3
import re
import sys

def fix_html_entities(content):
    # Order matters! More specific replacements first
    
    # Fix => arrow function
    content = content.replace('=&gt;', '=>')
    
    # Fix >= and <= comparisons
    content = content.replace('&gt;=', '>=')
    content = content.replace('&lt;=', '<=')
    content = content.replace('&gt;', '>')
    content = content.replace('&lt;', '<')
    
    # Fix && and ||
    content = content.replace('&amp;&amp;', '&&')
    content = content.replace('&amp;', '&')
    
    # Fix Record<string, ...>
    content = re.sub(r'Record<([^>]+)>', lambda m: 'Record<' + m.group(1).replace('&lt;', '<').replace('&gt;', '>') + '>', content)
    
    # Fix Promise<...>
    content = re.sub(r'Promise<([^>]+)>', lambda m: 'Promise<' + m.group(1).replace('&lt;', '<').replace('&gt;', '>') + '>', content)
    
    return content

if __name__ == '__main__':
    for filepath in sys.argv[1:]:
        with open(filepath, 'r', encoding='utf-8') as f:
            content = f.read()
        new_content = fix_html_entities(content)
        if content != new_content:
            with open(filepath, 'w', encoding='utf-8') as f:
                f.write(new_content)
            print(f'Fixed: {filepath}')
        else:
            print(f'No changes: {filepath}')
