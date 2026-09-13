#!/usr/bin/env perl
# coerce-wasm-readside.pl — read-side rocq-runtime patches needed ONLY by the
# wasm_of_ocaml engine. They do NOT affect .vo output and are no-ops on
# native/js_of_ocaml. Applied by web/build-real.sh to the coerce-32bit source
# tree before rebuilding lib.cma / clib.cma. Idempotent (marker-guarded).
#
#  * lib/system.ml apply_subdir: use Sys.is_directory/Sys.file_exists (virtual-fs
#    aware) instead of Unix.stat (the in-browser VFS has no Unix.stat, so the
#    mounted coqlib would be skipped by the loadpath scanner).
#  * lib/system.ml file_exists_respecting_case: avoid Filename.concat path "."
#    (-> "path/.") which the virtual fs cannot readdir; use [path] when df = ".".
#  * clib/cUnix.ml canonical_path_name: when Sys.chdir into an absolute VFS path
#    fails, return the path itself instead of prepending the real cwd.
use strict; use warnings;
my $root = $ARGV[0] or die "usage: coerce-wasm-readside.pl <rocq-src>\n";
sub patch { my ($file,$marker,$from,$to)=@_; local $/; open my $fh,'<',$file or die "$file: $!";
  my $s=<$fh>; close $fh; return if index($s,$marker)>=0;         # already applied
  my $n=($s=~s/\Q$from\E/$to/); die "pattern not found in $file\n" unless $n;
  open my $out,'>',$file or die $!; print $out $s; close $out; print "patched $file\n"; }

patch("$root/lib/system.ml", "if (try Sys.is_directory path with Sys_error _ -> false)",
"    match try (Unix.stat path).Unix.st_kind with Unix.Unix_error _ -> Unix.S_BLK with\n    | Unix.S_DIR when name = base -> f (FileDir (path,name))\n    | Unix.S_REG -> f (FileRegular name)\n    | _ -> ()",
"    if (try Sys.is_directory path with Sys_error _ -> false)\n    then (if name = base then f (FileDir (path,name)))\n    else if (try Sys.file_exists path with Sys_error _ -> false) then f (FileRegular name)");

patch("$root/lib/system.ml", "if String.equal df Filename.current_dir_name then path",
"    (String.equal df \".\" || String.equal f df || aux df)\n    && exists_in_dir_respecting_case (Filename.concat path df) bf",
"    let dir = if String.equal df Filename.current_dir_name then path else Filename.concat path df in\n    (String.equal df \".\" || String.equal f df || aux df)\n    && exists_in_dir_respecting_case dir bf");

patch("$root/clib/cUnix.ml", "else remove_path_dot p",
"  with Sys_error _ ->\n    (* We give up to find a canonical name and just simplify it... *)\n    current ^ dirsep ^ strip_path p",
"  with Sys_error _ ->\n    if Filename.is_relative p then current ^ dirsep ^ strip_path p\n    else remove_path_dot p");
print "coerce-wasm read-side patches OK\n";
