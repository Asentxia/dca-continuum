(module
  (func (export "run") (result i32) (local $n i32) (local $s i32)
    i32.const 100 local.set $n
    (loop $again
      local.get $n local.get $s i32.add local.set $s
      local.get $n i32.const 1 i32.sub local.tee $n br_if $again)
    local.get $s))
