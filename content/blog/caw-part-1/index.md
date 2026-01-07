+++
title = "CAW (part 1)"
date = 2026-01-07
path = "caw-part-1"

[taxonomies]
tags = ["project", "software"]

[extra]
og_image = "caw.jpg"
+++

[CAW](https://github.com/gridbugs/caw) started out as a rewrite of [Llama](@/blog/llama/index.md) into Rust.
It's a software-defined modular synthesizer - a library that can be used to create synthesizers by declaratively
describing a graph of interconnected modules. I rewrote Llama in Rust because I was frustrated with the state
of OCaml development tooling (read more about this [here](https://www.gridbugs.org/frustrating-interactions-with-the-ocaml-ecosystem-while-developing-a-synthesizer-library/)).
This post covers the state of CAW as of around the end of 2024 when I rewrote it
pretty much from scratch with an eye for performance.
I'll cover the basic concepts in this post, as well as some considerations in
switching from OCaml to Rust, and in part 2 I'll focus on what I've changed and
added since then.

![The CAW logo - a crow playing a keytar](caw.jpg)

As with Llama, the core concept is signals - streams of values where elements are produced at the
sound card's sample rate (usually about 44kHz). In CAW the main type is `Signal<T>` representing a stream
of some type `T`. Here's an example showcasing the main differences between doing this in OCaml and Rust.
I'll show the code for a simple synthesizer implemented with Llama and CAW, then discuss the differences.

```ocaml
open Llama
open Dsl

let () =
  let osc = oscillator (const Saw) (const 100.0) in
  let gate = periodic_gate ~frequency_hz:(const 5.0) ~duty_01:(const 0.05) in
  let env = ar_linear ~gate ~attack_s:(const 0.01) ~release_s:(const 0.15) in
  let osc_filtered =
    osc |> butterworth_low_pass_filter ~cutoff_hz:(env |> scale 20000.0)
  in
  let output = osc_filtered *.. env in
  play_signal output
```

```rust
use caw::prelude::*;

fn main() -> anyhow::Result<()> {
    let osc = oscillator_hz(Waveform::Saw, 100.0).build();
    let gate = periodic_gate_s(0.2).duty_01(0.05).build();
    let env = adsr_linear_01(&gate).attack_s(0.01).release_s(0.15).build();
    let osc_filtered =
        osc.filter(low_pass_butterworth(env.clone() * 20_000.0).build());
    let output = osc_filtered * env;
    SignalPlayer::new()?.play_sample_forever(output)
}
```

Both of these programs play a 100Hz sawtooth wave modulated by an envelope that
controls both the volume and filter cutoff.

A major difference is that in Rust there are no named function parameters.
If the inputs to modules were passed as regular function arguments then it will
be difficult to tell the meaning of each argument at a glance.
To work around this, in CAW modules are created using the "builder pattern".
If there are mandatory arguments whose meaning is obvious without a label then
they are passed as regular (anonymous) arguments to the "constructor" (functions
like `oscillator_hz` and `low_pass_butterworth`) which creates a builder for the
respective module type. Then methods can be chained onto the builder which
override default values for any other module parameters. Finally the `.build()` method
actually creates the module.

An alternative to the builder pattern might be to use structs of arguments.
In Rust a struct literal is written with named fields, and if the struct
implements the `Default` trait then it's quite ergonomic to omit fields and use
their default values.
Had I gone down this route, the
`adsr_linear_01` module could be created like:
```rust
AdsrLinear01Args {
    gate,
    attack_s: 0.01,
    release_s: 0.15,
    ..Default::default(),
}.build()
```

I opted to not use this approach because it felt was less
ergonomic. Code formatters would tend to split definitions over multiple
lines rather than putting definitions all on a single line as with (at least
short) chains of methods when using the builder pattern.
It also requires that the struct implements `Default` which might not make
sense. The builder pattern allows modules to have both mandatory and optional
fields.

Another big difference is that in Llama, when passing a constant value to a
function which expects a signal, the `const` function must be used to produce a
signal which always yields a given value. This is not necessary in CAW.
To understand, let's take a look at the types of the
`periodic_gate`/`periodic_gate_hz` functions.

In Llama its type is:
```ocaml
(* The ['a t] type constructor represents signals yielding values of type 'a. *)
val periodic_gate : frequency_hz:float t -> duty_01:float t -> Gate.t
```

In CAW its type is:
```rust
fn periodic_gate_s(freq_s: impl Into<Signal<f64>>) -> PeriodicGateBuilder
```

CAW uses the `Into` trait to allow functions to take values of any type which
can be converted into signals. The `f64` type implements this trait, converting
scalar values to constant-valued signals. Similarly in Rust the arithmetic operators can
be overloaded to allow signals to be multiplied by other signals or by scalars as in `osc_filtered * env` and `env.clone() * 20_000.0`.
In Llama I needed to define a new operator `*..` for multiplying signals with other
signals, and the helper function `scale` multiplies a signal with a scalar.

Rust lacks a pipeline operator like OCaml's "`|>`", however code that would be
written as pipelines in OCaml translate naturally into chains of method.
I wanted to avoid making every module a method of `Signal<T>` so
I introduced the concept of a `Filter`, which is a trait defined like:
```rust
trait Filter {
    type Input;
    type Output;

    fn run(&self, input: Self::Input, ctx: &SignalCtx) -> Self::Output;
}
```

The `Input` and `Output` types are usually `Signal<f64>`.
This trait is a little too generic in hindsight, and is refined in more recent
versions of CAW.

The `filter` method in the example above takes an implementation of `Filter`
and applies it to `self`. It's common to chain successive calls of `filter` to
apply a sequence of filters to a signal.

Since CAW is written in Rust we have to think a bit about memory. Note how the
CAW example calls the `.clone()` method on the envelope. Here's the relevant
parts of the code again:

```ocaml
...
let env = ar_linear ~gate ~attack_s:(const 0.01) ~release_s:(const 0.15) in
let osc_filtered =
  osc |> butterworth_low_pass_filter ~cutoff_hz:(env |> scale 20000.0)
in
let output = osc_filtered *.. env in
...
```

```rust
...
let env = adsr_linear_01(&gate).attack_s(0.01).release_s(0.15).build();
let osc_filtered =
    osc.filter(low_pass_butterworth(env.clone() * 20_000.0).build());
let output = osc_filtered * env;
...
```

If the Rust example above were changed to do `env * 20_000.0` instead of cloning
then the `env` variable would be consumed by that multiplication, and wouldn't be
available the next time it's needed by the `osc_filtered * env` on the following
line.

This highlights a design consideration when building Llama as well as CAW, which
is how to handle the situation where the output of one module is used as the
input to multiple other modules. In the analog world, depending what type of
cables you use you might be able to plug multiple cables into each other to
easily split or join a signal.

![An analog synthesizer module with a stack of multiple cable terminators plugged into the same jack
socket.](stacked-banana-jacks.jpg)

Llama and CAW both evaluate modules "top-down". When evaluating an operation
like `osc_filtered * env` during each audio sample, first a sample will be
produced from `osc_filtered`, then a sample will be produced from `env`, then
those samples will be multiplied. Evaluating `osc_filtered` means computing the
output of the low-pass filter, which in turn needs to compute the output of the
oscillator and so on. Top-down evaluation can be thought of as the sample values
being _pulled_ out of modules which can then pull values out of other modules
and so on. This is distinct from a bottom-up evaluation where values are
_pushed_ from the most simple modules in the signal graph through more complex
values.

The envelope generator `env` is evaluated twice in the example. We really want both evaluations
to result in the same value each sample, and we don't want to have to repeat the work of
recomputing its value if it's already been computed once during the current
sample. For this reason, each signal internally includes a cache of the sample
value computed for that signal during the current sample. In CAW when you
`.clone()` a signal you get a shallow copy that shares its cache with any other
copies.

Computing the value yielded by a signal might modify the signal's internal
state. Since signals are shared when they are cloned, this means we need a
shared mutable value. In Rust this requires wrapping signals in something like
`Rc<RefCell<...>>` and calling `.borrow_mut()` before mutating.
This is all handled internally by the `Signal<T>` type, so it doesn't leak into
synthesizer code. Still
doing this felt a little ugly and removed the ability of the compiler to
optimize in some cases but it seemed essential for ergonomics. Eventually I
found a way to have my cake and eat it too, which will be covered in part 2.

That's all for part 1. It didn't take long to reach feature parity with Llama
since all the complex logic was already implemented. I went a bit further,
adding browser support and a couple of other modules such as reverb, a bit
crusher, and synthesized drums.

CAW is easy to include in other Rust projects. Here
are some of my projects that use CAW:
 - [Generative Music
   Experiment](https://gridbugs.github.io/generative-music-experiment/),
   plays random notes while maintaining a musical "context" so the music
   feels like it's in a particular key and mode.
 - [Electric Organ](https://gridbugs.itch.io/electric-organ) is a roguelike I
   made for a game jam where the music is procedurally generated along with game
   content.
