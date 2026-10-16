# Preparation and slicers

QuickPrint's Windows executable includes its app runtime. To turn model files into
printer instructions, install a compatible OrcaSlicer, Bambu Studio, or PrusaSlicer
on the same PC, then set its executable path and exported profiles in Settings.
Already-sliced files do not require a slicer installation.

For Bambu Studio/OrcaSlicer, select three exported preset files in this exact order:
machine, process, filament. Export complete compatible presets for the selected
printer/nozzle/material; inherited presets must be resolvable by that slicer.
For PrusaSlicer, select one or more exported INI files. Settings supplies the
default configuration; each printer can override the executable and profiles
in its connection settings. Use those overrides for a mixed fleet. Do not use
Bambu machine presets for generic firmware.

Inputs: STEP/STP, STL, OBJ, model 3MF, plain G-code, sliced single-plate G-code 3MF.
STEP support depends on the selected Orca/Bambu build. Prusa integration requests
an STL conversion for STEP files. Native proprietary CAD files are not imported.
The first release requires one plate per artifact; export multi-plate projects as
separate files. Quantities count repetitions of the submitted file, not the number
of models already arranged on a pre-sliced plate.

Bambu LAN printers require a printer-compatible `.gcode.3mf`. OctoPrint,
Moonraker, and Duet use compatible plain `.gcode`. QuickPrint rejects attempts to
forward an imported Bambu 3MF to another family. When Orca is explicitly configured
with the target printer's profiles, QuickPrint can extract its generated G-code
from the slicer's output container for that printer.

The preparation worker preserves original files, hashes prepared artifacts and
profiles, binds artifacts to the selected printer, validates 3MF structure and
bounded archive expansion, and treats failed/missing slicer output as an error.
It does not infer that user-supplied G-code matches a nozzle, bed, or material;
the operator must confirm that match before starting a physical print.

The bounded 3MF inspection helpers are reused from PS AM Print's source snapshot;
provenance is recorded in `src/slicing/psam/NOTICE.md`. Its factory-specific material
policies are not enabled in QuickPrint. The current Windows package does not
bundle PS AM's separate STEP orientation engine or a slicer distribution.
