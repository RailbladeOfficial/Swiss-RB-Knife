/* =============================================================================
   RNGESUS (random number generator): persistence
   -----------------------------------------------------------------------------
   Settings and the current pool of generated numbers, in rng.json, same as
   every other tool's data file.

   THE NUMBERS THEMSELVES ARE NOT GENERATED HERE, and that is deliberate. The
   frontend draws them from the WebView's CSPRNG (crypto.getRandomValues), which
   is the same class of source a Rust-side generator would use, so moving the
   draw across the boundary would buy nothing but a round trip per number. What
   the backend is for is the part the frontend cannot do: putting the pool on
   disk so a run of results survives closing the app.

   Saving the results at all is the point of the tool's "keep history" mode. A
   list of numbers you have to be able to reconstruct later is worth nothing if
   it evaporates with the window, and re-rolling is not a reconstruction: the
   numbers would be different ones.

   Rust commands exposed:
     save_rng_data, load_rng_data
============================================================================= */




