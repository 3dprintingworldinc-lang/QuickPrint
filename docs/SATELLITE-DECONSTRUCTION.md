# ELEGOO SatelLite: inspected automation boundary

Inspected on 2026-11-19. Installed build: **1.0.2.18**, executable SHA-256
`8330bc5afb1b6a2105cd85e7653cc86717621739b9cbdabdebbf8d1d7c8c4b4f`.
Installation root used below:
`C:\Program Files\ELEGOO SatelLite\ELEGOO SatelLite`.

The installation has a real preparation command-line interface. Its supported
help does **not** expose support generation, slicing, GOO export, or printer
dispatch. Those operations exist in the native desktop application, but native
symbol names are not a supported external API. Full unattended resin preparation
and physical printing are not qualified by this investigation.

## Evidence and capability map

| Process | Evidence in this installed build | Automation status |
| --- | --- | --- |
| Import a model | Executable help: `--add-model`; `EleFramework.dll` has `CMDParser::openFiles` | Registered CLI; unattended result still requires qualification |
| Evaluate mesh | Help: `--evaluate`; `CMDParser::evaluate`, `Std_Evaluate` | Registered CLI; no report was produced by the local synthetic probe |
| Repair mesh | Help: `--fix simple/standard`; `CMDParser::fix`, `Std_SimpleFix`, `Std_StandardFix` | Registered CLI; synthetic probe produced no output model |
| Hollow mesh | Help: `--hollow <thickness>`; `CMDParser::hollow`, `Std_RunHollow` | Registered CLI; geometry result untested |
| Add text label | Help: `--labeling <text-label>`; `CMDParser::textLabel` | Registered CLI; not enabled by QuickPrint wrapper |
| Arrange/orient models | Installed `EleArrange.dll`, `EleOrient.dll`, `EleTriArrange.dll`, `EleTriOrient.dll` | Native implementation present; no external invocation verified |
| Generate supports | Native support command registry and `resources\script\common\*.satsup` presets | No supported CLI invocation found |
| Slice | `EleImageApp.dll`: `Std_SliceParts`, `Std_SlicePartsInSinglePlatformFrame`, `Std_SlicePartsInAdvancedInSinglePlatformFrame` | Desktop command registry only |
| Export sliced resin file | `EleImageApp.dll`: `Std_ExportSlice`, GOO encoder and export strings | Desktop operation; no supported CLI invocation found |
| Transfer and control printer | `EleNetManager.dll`: HTTP endpoint templates, SDCP topics, WebSocket address; `EleMqtt.dll` | Transport families identified; model and firmware qualification needed |

This table distinguishes runtime help from static binary evidence. It does not
establish that private C++ methods can safely be called outside their application.

## Verified command-line help

Running the installed executable with `--help`, with no model or printer involved,
exited with code 0 and printed:

```text
Usage: ...\ELEGOO SatelLite.exe [options] url
ELEGOO SatelLite, Fast and Streamlined Preparation.

  -?, -h, --help               Displays help on commandline options.
  --help-all                   Displays help including Qt specific options.
  -v, --version                Displays version information.
  -m, --add-model <filename>   Add a model into ELEGOO SatelLite.
  -o, --output <out-folder>    Save file to directory.
  --hide                       Do you want ELEGOO SatelLite display to start.
  -l, --labeling <text-label>  Add a text label to the selected part(s).
  --evaluate                   Detect errors in the model.
  -f, --fix <simple/standard>  Repair imported model.
  --hollow <thickness>         Hollow the selected part.

Arguments:
  url                          The URL(s) to open.
```

`--version` exited with code 0 and printed `ELEGOO SatelLite 1.0.2.18`.
These are observed arguments; no `--slice` or `--export-goo` flag was invented.
The `.cli` export label found in the native application means **Common Layer
Interface**, a layer-data format; it does not establish a command-line slicer.

## Real synthetic-model probes

A new four-triangle tetrahedron STL was created in a temporary directory. Two
hidden processes were run with argument arrays, without a shell:

```text
--hide --add-model <temporary tetra.stl> --evaluate --output <empty directory>
--hide --add-model <temporary tetra.stl> --fix simple --evaluate --output <empty directory>
```

Both processes ended, and the second observed exit code was 0. Neither produced
stdout, stderr, a model, or an evaluation report in its output directory. The
second probe completed before its 45-second timeout. Exit code 0 therefore does
not demonstrate a successful mesh operation.

An existing SatelLite desktop instance remained running throughout. The executable
contains `SingleInstanceIdentify` and imports `QSharedMemory::attach`,
`isAttached`, and `detach`. `EleFramework.dll` also contains shared-memory handling
and a `CMDParser` command queue. Single-instance coordination is a **possible**
explanation for the absent files; it is not proven. The existing instance was not
closed, its scene was not inspected or edited, and no printer command was sent.
No conclusion that the vendor CLI is broken follows from these probes.

Temporary evidence was written under `%TEMP%\quickprint-satellite-probe` and
`%TEMP%\quickprint-satellite-help.stdout.txt`. Only filtered startup/termination
messages were inspected in the application log; credentials were not exported.

## Native implementation and data boundaries

* The executable and `EleFramework.dll` identify a Qt 5 desktop application with
  modular native geometry, slicing, networking, and UI libraries. VoxelDance
  references in `environment\env.ini` and native class names establish shared
  implementation lineage; they do not supply source code or an SDK license.
* The installation includes `python37.dll` and `python3.dll`. No vendor Python
  wrapper, `.py` automation scripts, `.pyd` modules, or documented Python API were
  found in the inspected installation inventory. Bundled runtime libraries alone
  are insufficient to treat the application as scriptable through Python.
* `resources\resin\material\100.data` is JSON with a `platitem` object containing
  machine/build parameters. `resources\machines\printer\officialPlatform.ini`
  stores named printer and resin settings, including `Printer\LayerThickness`,
  exposure/lift/retract values, mirroring, resolution, and network support flags.
  Many numeric INI values use Qt `@Variant(...)` encoding, so a generic INI parser
  will not recover their numeric values correctly without decoding.
* `resources\script\common\*.satsup` files are binary preset containers with
  support-generation parameter names. They are not executable Python scripts.
  The native file associations identify `.satres` resin presets, `.satsup`
  support presets, `.elesat` projects, `.3mf` models/projects, and `.goo` slices.
* The local preset table marks Mars 4 Ultra, Mars 5 Ultra, Saturn 3 Ultra, Saturn 4
  Ultra, Saturn 4 Ultra 16K, and Jupiter 2 as network-capable. It gives Jupiter 2
  a different sliced-file suffix version. This is preset metadata, not proof
  that every listed model uses an identical transport or slice format version.

## Printer transport evidence

`EleNetManager.dll` contains `ws://%1:3030/websocket`, SDCP request/status/
attributes/response topic strings, and separate HTTP templates including
`/api/printer/profile`, `/api/files`, `/api/upload/start`, `/api/upload/stop`, and
`/api/print/start`. `EleMqtt.dll` and a bundled Mosquitto distribution show another
transport dependency. Mapping these paths to a printer model requires a real
device and firmware; these strings are not sufficient request specifications.

For a documented SDCP v3 implementation, CBD Technology's
[published protocol](https://github.com/cbd-tech/SDCP-Smart-Device-Control-Protocol-V3.0.0/blob/main/SDCP%28Smart%20Device%20Control%20Protocol%29_V3.0.0_EN.md)
defines JSON messaging, UDP discovery, a WebSocket connection, attributes,
capability reporting, transfer, control, and status. This gives a primary-source
starting point after the actual printer is identified. It does not prove
firmware-specific compatibility.

ELEGOO publishes a
[GOO format specification](https://github.com/elegooofficial/GOO/blob/main/Goo%20Format%20Spec%20V1.2.pdf).
Any encoder/validator must be matched to the target model, file version,
resolution, mirroring, exposure parameters, and firmware. An STL, project 3MF,
filament G-code file, or renamed extension is insufficient as a resin print file.

## Further static call-graph findings

Read-only PE export/import and x64 disassembly inspection established narrower
calling boundaries than symbol-string searches alone:

* `EleFramework.dll` exports `CommandManager::getCommandByName` (RVA `0x99180`)
  and `runCommandByName` (`0x99230`). The latter finds a command in the current
  application registry, checks its blocked state, and dispatches through the
  command object's virtual table. This is an **in-process C++ host interface**;
  it is not an HTTP, CLI, or cross-process command endpoint.
* `CMDParser::evaluate` (`0x157bc0`) opens models through `OpenSaveManager`, looks
  up `Std_Evaluate`, and invokes that same virtual command operation. `fix`
  selects `Std_SimpleFix` or `Std_StandardFix`; `hollow` selects `Std_RunHollow`
  and stores parameters in the parser's C++ map. These paths require the
  application's document, UI, event loop, and command registry.
* `EleImageApp.dll` exports `USlicer::StartSlicing` (`0x147e00`) and
  `SaveFileSlice::SaveFile` (`0x1082f0`). Their signatures require internal
  `VoxSliceKernel`, `MeshKernel`, slicing/export parameter structures, C++
  containers, and callbacks. No standalone C ABI accepting an STL path and
  returning a GOO path was found in the inspected export tables.
* Most application feature libraries export `initDLLModule`. The executable
  imports `LoadDLLs::loadDlls` from `EleRegister.dll`; this identifies an internal
  module loader. It does not establish a documented third-party plugin ABI or
  permission to load an arbitrary automation DLL. The installation's `plugin`
  directory contains installer helpers, rather than a discovered script SDK.
* The shared-memory functions in `EleFramework.dll` around RVAs `0x1555e0`,
  `0x155820`, and `0x155b40` serialize/recover a cache-directory path selected
  through `environment\key.ini`. They are not a discovered arbitrary-command
  transport. This is separate from the executable's single-instance marker.
* `MainWindow::openUrl` (`0x115230`) calls `QUrl::toLocalFile` and the normal file
  opener. Its inspected path does not dispatch `Std_*` commands. Executable
  strings associate `satelliteslicer://` with login-token and file-download
  handling; that URI must not be treated as a generic slicing RPC interface.
* `EleImageApp.dll` has a concrete external-tool integration: UVtools command
  executable references, `print-formats`, and `--json`; `EleFramework.dll` has
  UVtools path/settings and version checks. This supports investigating UVtools
  as an independent slice-file conversion/inspection tool, without calling
  SatelLite's private geometry ABI.

No binary was patched, loaded into a custom host, or called through a private ABI
during this inspection. The addresses are version-specific investigation evidence.

## Installed Saturn 4 Ultra 16K preset

The vendor `officialPlatform.ini` section `[23]` was decoded read-only. The
observed numeric variants consist of a four-byte big-endian type marker `135`
followed by one big-endian IEEE-754 float32. This gives the following installed
defaults, rounded to their intended decimal precision:

| Setting | Installed default |
| --- | --- |
| Printer | ELEGOO Saturn 4 Ultra 16K |
| Build dimensions | 211.68 x 118.37 x 220 mm |
| Resolution | 15120 x 6230 pixels |
| Pixel pitch | 14 x 19 micrometres |
| Image mirrors | X false; Y true |
| Tilt flag | `InclinePrinter=true` |
| Slice format | `goo`; suffix version 1 |
| Normal profile layer height | 0.05 mm |
| Bottom layers / transition layers | 5 / 10 |
| Normal / bottom / first exposure | 2.3 / 32 / 32 seconds |
| Bottom wait after retract | 1.2 seconds |
| Lift/retract distance and speed fields | Zero in this tilt-printer preset |
| Antialias and image blur | Disabled |
| Normal and bottom light PWM | 255 |

These are the shipped **preset defaults**, not a resin calibration or a capture
of the user's currently adjusted scene. In particular, zero motion fields must
not be replaced with guessed Cartesian lift/retract settings. Header mirroring
flags also require a consistent bitmap convention across the upstream slicer and
downstream converter; matching the flag alone cannot validate image orientation.

## QuickPrint code added in this workspace

`src/slicing/satellite.js` provides:

* `inspectInstallation(installDir?)`: calls the real `--help` and `--version`,
  hashes the executable, and reports preparation flags separately from missing
  slicing/dispatch capabilities. `endToEndQualified` is false.
* `preprocess({ inputPath, outputDir, executable?, fix?, hollowThicknessMm?,
  evaluate?, signal?, timeoutMs? })`: an experimental STL preparation probe.
  It copies the source into a unique work directory, uses only registered CLI
  flags, bounds runtime and file output, hashes results, and rejects a zero-exit
  run with no model or JSON report as `SATELLITE_NO_OUTPUT`.
* Generated models/reports remain preparation evidence. The result always has
  `printReady: false`, `slicingPerformed: false`, and `evaluationPassed: null`;
  the vendor report schema and geometry quality have not been established.

`tests/satellite.test.js` checks flag validation, capability reporting, source
preservation, output hashing, cancellation propagation, and the observed
zero-exit/no-output failure. Fixture-runner tests establish wrapper behavior, not
the vendor engine's geometry correctness. A separate direct call to
`inspectInstallation()` succeeded against the real installed executable.

The independent `src/slicing/goo.js` reader validates the fixed GOO V3.0 header,
all layer records, bounded numeric fields, image RLE grammar, per-layer checksum,
exact decoded pixel counts, geometry expectations, delimiters, and footer. It
tracks color/run state without allocating full-resolution pixel arrays. Its
format layout and RLE grammar follow the vendor specification; byte order,
checksum convention, and footer were cross-checked against public
[UVtools format source](https://github.com/sn4k3/UVtools/blob/master/UVtools.Core/FileFormats/GooFile.cs)
and an independently generated local file. No UVtools implementation was copied
into this reader.

The real `.cache\resin-probe\cube.goo` passed this structural reader: 200 layers,
512 x 256 pixels, 40 x 20 mm, 10 mm final Z, 56,375 encoded image runs. Its SHA-256
was `36afbabfd80bf4299db040aeb0d7e1498d8108b2c58f2eac02f261441352fe29`.
This small synthetic artifact is not a Saturn 16K production file. The reader's
supported scope is the inspected fixed V3.0 layout, specified 4-bit and 8-bit
grayscale modes, and increasing layer Z positions; unsupported variants fail explicitly.
It returns `printerCompatible: false`. Structural validation cannot find every
island, suction cup, orientation mistake, incorrect cure setting, unsupported
firmware feature, or other physical-print failure.

## Real native desktop export and structural validation

The existing desktop scene already contained `Case.stl` in Preview with 1,344
layers and the ELEGOO Saturn 4 Ultra 16K / Normal / 50-micrometre selection. The
root agent used the Windows computer-use workflow to select **Save Sliced File**,
choose the output directory through its folder picker, and select **Confirm**.
The folder path was chosen through the picker rather than typed into its
noneditable inline display. No printer start was requested, and this operation
did not regenerate or modify the unsaved model scene. This verifies the current
Preview-to-file export operation; it does not establish unattended import,
orientation, support generation, or slicing of new models inside SatelLite.

The resulting local evidence file is
`scratch\native-export\Case-satellite-probe.goo`. It is deliberately excluded
from source control because it is 218,451,945 bytes (about 208 MiB) and contains
the user's model. Its SHA-256 is
`ad53855d72e7b31cdd66380df37aeca762289aae8a3bd0fc75e32c130ad1c1b9`.

The independent reader fully validated this file using a 512 MiB file limit and
explicit expected 16K geometry/mirroring. All 107,010,566 RLE runs, 1,344 image
checksums, decoded image lengths, layer records, and the exact footer passed.
The observed validation took about 1.83 seconds on this workstation, without
expanding the 94,197,600 pixels in each layer into image arrays.

| Native export field | Observed value |
| --- | --- |
| Writer | ELEGOO SatelLite 1.0.2.18 |
| File / encoding | GOO V3.0; grayscale mode 0 (4-bit) |
| Machine name and type | ELEGOO Saturn 4 Ultra 16K |
| Resolution / display | 15120 x 6230; 211.68 x 118.37 mm |
| Build Z / final sliced Z | 220 / 67.2 mm |
| Layers / layer height | 1344 / 0.05 mm |
| Mirror flags | X false; Y true |
| Profile | Normal |
| Normal / bottom exposure | 1.6 / 18 seconds |
| Bottom / transition layers | 5 / 10 |
| Per-layer parameter override flag | False; header/global parameter mode |
| Wait after retract | 1.2 seconds for bottom and common layers |
| First-stage lift/retract distance and speed fields | 0.05 in the native serialized header |
| Antialias / blur | 0 / 0 |

The native 4-bit mode differs from the earlier UVtools-generated 8-bit file. The
reader now interprets full-white runs as the selected mode's maximum (15 or 255)
and bounds explicit/difference grayscale values accordingly. A regression test
covers 4-bit runs and rejects overflow above 15; unknown mode values still fail.
The observed native image stream used only black/full-white run types.

The actual scene's 1.6/18-second exposures differ from the shipped 2.3/32-second
defaults decoded above. The serialized native tilt-motion fields also differ
from the preset's zero motion fields. These differences are evidence that
presets, current scene settings, and encoded file values must be recorded
separately. No structural check establishes that these cure or motion values
are physically appropriate for a particular resin or firmware.

## Headless fallback and quantity evidence

QuickPrint's implemented headless alternative uses PrusaSlicer SLA -> SL1 ->
UVtools GOO, with independent layer validation and print-issue analysis. See the
[headless engine guide](HEADLESS-RESIN-ENGINE.md) for tested versions, profiles,
reproduction commands and physical qualification limits. This does not expose a
new SatelLite SDK or make its private methods callable.

The engine records `modelCopiesPerRun: 1`: one submitted source instance, not a
disconnected-component, physical-part or accepted-unit count. Initial repeat
planning requires the operator to declare that the whole model is one order
unit. Printing and QC must supply the actual run/accepted quantities.

Prusa's advertised duplication flags were exercised separately with the 3 mm
fixture cube, a 40 x 20 mm bed and supports/pad disabled. Requests for 1, 2 and 20
copies each exited 0; material was 0.027, 0.054 and 0.270 mL respectively. Layer
30 contained 1, 2 and 10 separate cube footprints. The 20-copy export omitted ten
requested cubes without a failing exit. Tagged
[transform source](https://github.com/prusa3d/PrusaSlicer/blob/version_2.9.7/src/CLI/ProcessTransform.cpp)
and [slicing source](https://github.com/prusa3d/PrusaSlicer/blob/version_2.9.7/src/CLI/ProcessActions.cpp)
show duplication, arrangement and selection of bed 0. The actual SL1 metadata
provided no instance-count/footprint contract. Ignored evidence is in
`scratch/resin-plate-plan/`. QuickPrint therefore sends no duplication flags;
validated multi-instance placement/counting remains future work.

## Remaining qualification work

1. In an isolated Windows account/session with no existing SatelLite instance,
   repeat the small-model preparation probes and establish actual output names,
   report schema, scene side effects, and exit/error behavior.
2. For unattended SatelLite use, obtain a supported batch interface or establish a repeatable desktop
   automation flow for arrange/orient, hollow/drain, supports, slice, inspect,
   and GOO export. Record each operation's settings and output hash. Private DLL
   symbols should remain investigation leads until calling contracts and
   initialization/lifetime requirements are understood.
3. Physically qualify a confirmed printer model, firmware, resin, plate profile
   and slice format. The SDCP adapter's real read-only status/attribute calls
   succeeded, but upload/start/control remain fixture-tested and unqualified on
   hardware. Resolve the geometry discrepancy in the
   [SDCP guide](SDCP-INTEGRATION.md#observed-geometry-discrepancy).
4. Deploy the reviewed Layr production API and provision its scoped token and
   qualification bindings. Local intake and preparation-evidence outbox preserve
   ticket/artifact identities; physical completion, post-processing and accepted
   part quantities still require production evidence.
