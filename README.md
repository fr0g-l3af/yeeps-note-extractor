# Yeeps Note Extractor

The Yeeps Note Extractor is a web-based application designed to extract musical notes from a MusicXML file and generate a Yeeps-compatible build map (text). This application is a local run webpage with javascript (no server side processing). It is also hosted on GitHub Pages for ease of use.

## Table of Contents

1. [Getting Started](#getting-started)
2. [Usage](#usage)
3. [License](#license)

## Getting Started

1. **Access the Application:**
   - Goto [https://fr0gl3af.github.io/yeeps-note-extractor](https://fr0g-l3af.github.io/yeeps-note-extractor).

## Usage

1. **Upload a MusicXML File:**
   - Go to the web interface.
   - Click on the "Upload" button to select and upload a MusicXML file. You can use the example file `examples/never-gonna-give-you-up-yeeps.musicxml` provided in the repository.
   - Approve the auto selection or choose a **note grid** (8th / 16th / 32nd / 64th) and tempo. The tempo list depends on the grid (finer grids support slower max ♩). Conversion is blocked if the score needs a finer grid than selected, or if follow-tempo marks exceed that grid’s 1-space limit.
   - Leave “follow tempo changes” unchecked to keep that one tempo for the whole piece. Check it to follow each numeric tempo marking from that point on, snapped to the nearest Yeeps tempo for the selected grid. Marks without a number (rit., accel.) are ignored.
   - Adjust the number of divisions if needed (usually not).
   - Click the "Convert" button to see the extracted note map.
   - Click the "Download .txt" button to download/copy the text file.

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for more information.
