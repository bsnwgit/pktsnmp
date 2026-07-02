"""Local backup script — copies the pktSNMP project to the Backups folder."""
import shutil, datetime, pathlib

src = pathlib.Path(r'C:\Users\USER\My Drive\Documents\Claude\Projects\pktSNMP')
ts  = datetime.datetime.now().strftime('%Y%m%d_%H%M%S')
dst = pathlib.Path(r'C:\Users\USER\My Drive\Backups\pktSNMP') / f'pktSNMP_backup_{ts}'

excludes = {'.git', 'node_modules', '__pycache__', 'dist', '.venv', 'venv', '.mypy_cache'}

def copy_tree(s, d):
    d.mkdir(parents=True, exist_ok=True)
    for item in s.iterdir():
        if item.name in excludes:
            continue
        if item.is_dir():
            copy_tree(item, d / item.name)
        else:
            shutil.copy2(item, d / item.name)

copy_tree(src, dst)
count = sum(1 for _ in dst.rglob('*') if _.is_file())
print(f'Backup complete: {dst}')
print(f'Files copied: {count}')
