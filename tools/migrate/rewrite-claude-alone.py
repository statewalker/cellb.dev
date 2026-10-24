# git filter-repo --commit-callback body: commits Claude made alone ("Claude (for Mikhail
# Kotelnikov)") become Mikhail's, with Claude as co-author; every other commit is left as it is.
import re
if commit.author_name.startswith(b"Claude"):
    for k in ("author", "committer"):
        setattr(commit, k + "_name", b"Mikhail Kotelnikov")
        setattr(commit, k + "_email", b"mikhail.kotelnikov@gmail.com")
    msg = commit.message.rstrip(b"\n")
    if not re.search(rb"(?im)^Co-Authored-By: Claude", msg):
        paras = msg.split(b"\n\n")
        tail_is_trailers = len(paras) > 1 and all(re.match(rb"^[A-Za-z-]+: ", l) for l in paras[-1].split(b"\n"))
        msg += (b"\n" if tail_is_trailers else b"\n\n") + b"Co-Authored-By: Claude <noreply@anthropic.com>"
    commit.message = msg + b"\n"
