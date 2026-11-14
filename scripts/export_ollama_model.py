#!/usr/bin/env python3
"""
export_ollama_model.py — takes the merged HF model directory train_lora.py
produced, converts it to GGUF via a llama.cpp checkout, optionally quantizes
it, writes an Ollama Modelfile, and runs `ollama create`.

Called by distillation.js's exportToOllama() as a subprocess. Standalone use:

    python scripts/export_ollama_model.py \
        --model-dir memory/distillation/runs/<run-id>/model \
        --ollama-name jojo-local-<run-id> \
        --work-dir memory/distillation/runs/<run-id>/gguf

Requirements (all one-time setup — see DISTILLATION.md for the Windows
walkthrough):
  1. Ollama installed and on PATH (https://ollama.com/download/windows).
  2. A llama.cpp checkout, purely for its Python convert script — no build/
     compile step needed for that part. Point at it with --llama-cpp-dir or
     the LLAMA_CPP_DIR env var:
         git clone https://github.com/ggml-org/llama.cpp
  3. (Optional but recommended) a llama-quantize binary, to shrink the f16
     GGUF down to something Q4-ish. On Windows you do NOT need to build
     llama.cpp for this — grab the prebuilt "llama-*-bin-win-*.zip" from its
     GitHub Releases page and point --llama-quantize-bin at llama-quantize.exe
     inside it, or set LLAMA_QUANTIZE_BIN. Without it, this script just uses
     the full f16 GGUF — larger on disk, works identically otherwise.
"""

import argparse
import glob
import os
import shutil
import subprocess
import sys


def parse_args():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--model-dir', required=True, help='Merged HF model directory (train_lora.py --output-dir)')
    p.add_argument('--ollama-name', required=True, help='Name to register with Ollama, e.g. jojo-local-run-2026-...')
    p.add_argument('--work-dir', required=True, help='Scratch directory for the GGUF file(s)')
    p.add_argument('--llama-cpp-dir', default=os.environ.get('LLAMA_CPP_DIR'), help='Path to a llama.cpp checkout (for the convert script)')
    p.add_argument('--llama-quantize-bin', default=os.environ.get('LLAMA_QUANTIZE_BIN'), help='Path to llama-quantize(.exe) — optional')
    p.add_argument('--quant-type', default='Q4_K_M', help='Quantization type if a quantize binary is available')
    p.add_argument('--no-quantize', action='store_true', help='Skip quantization even if a binary is available — use full f16 GGUF')
    p.add_argument('--system-prompt', default=None, help='Optional SYSTEM line for the Modelfile')
    return p.parse_args()


def run(cmd, **kw):
    print(f'[export_ollama_model] $ {" ".join(cmd)}')
    result = subprocess.run(cmd, **kw)
    if result.returncode != 0:
        print(f'[export_ollama_model] command failed (exit {result.returncode})', file=sys.stderr)
        sys.exit(result.returncode)
    return result


def find_convert_script(llama_cpp_dir):
    # llama.cpp has renamed this script more than once across versions —
    # check the names actually in use rather than assuming one.
    candidates = ['convert_hf_to_gguf.py', 'convert-hf-to-gguf.py', 'convert.py']
    for name in candidates:
        path = os.path.join(llama_cpp_dir, name)
        if os.path.isfile(path):
            return path
    return None


def main():
    args = parse_args()
    os.makedirs(args.work_dir, exist_ok=True)

    if not args.llama_cpp_dir or not os.path.isdir(args.llama_cpp_dir):
        print('[export_ollama_model] No usable --llama-cpp-dir / LLAMA_CPP_DIR found.\n'
              '  git clone https://github.com/ggml-org/llama.cpp\n'
              '  then re-run with --llama-cpp-dir pointing at it.', file=sys.stderr)
        sys.exit(1)

    convert_script = find_convert_script(args.llama_cpp_dir)
    if not convert_script:
        print(f'[export_ollama_model] No convert script found in {args.llama_cpp_dir} '
              '(looked for convert_hf_to_gguf.py / convert-hf-to-gguf.py / convert.py — '
              'check your llama.cpp checkout is up to date).', file=sys.stderr)
        sys.exit(1)

    f16_path = os.path.join(args.work_dir, 'model-f16.gguf')
    run([sys.executable, convert_script, args.model_dir, '--outfile', f16_path, '--outtype', 'f16'])

    final_gguf = f16_path
    if not args.no_quantize and args.llama_quantize_bin and os.path.isfile(args.llama_quantize_bin):
        quant_path = os.path.join(args.work_dir, f'model-{args.quant_type.lower()}.gguf')
        run([args.llama_quantize_bin, f16_path, quant_path, args.quant_type])
        final_gguf = quant_path
    else:
        print('[export_ollama_model] No quantize binary given/found — using full f16 GGUF as-is.')

    modelfile_path = os.path.join(args.work_dir, 'Modelfile')
    lines = [f'FROM {os.path.abspath(final_gguf)}']
    if args.system_prompt:
        escaped = args.system_prompt.replace('"""', '\\"\\"\\"')
        lines.append(f'SYSTEM """{escaped}"""')
    with open(modelfile_path, 'w', encoding='utf-8') as f:
        f.write('\n'.join(lines) + '\n')

    if not shutil.which('ollama'):
        print('[export_ollama_model] "ollama" not found on PATH — install it from '
              'https://ollama.com/download and re-run this script (the GGUF/Modelfile above '
              f'are already built at {args.work_dir}, so you can also just run:\n'
              f'  ollama create {args.ollama_name} -f {modelfile_path}\n'
              'by hand once Ollama is installed).', file=sys.stderr)
        sys.exit(1)

    run(['ollama', 'create', args.ollama_name, '-f', modelfile_path])
    print(f'[export_ollama_model] Done. Registered as Ollama model "{args.ollama_name}".')


if __name__ == '__main__':
    main()

