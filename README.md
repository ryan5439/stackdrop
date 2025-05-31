# Stackdrop - Silent App Installer

Stackdrop is a web application that allows users to select multiple software applications and generate a single silent installer that installs all selected apps without user interaction.

## Features

- 🌐 **Web-based Interface**: Easy-to-use web interface for app selection
- 📱 **Mobile Responsive**: Optimized for desktop and mobile devices
- 🎯 **Dual Action Buttons**: Generate buttons at top and bottom of the page
- ✅ **Smart Button States**: Buttons are disabled until at least one app is selected
- 🎨 **Category Icons**: Emoji icons for different app categories
- 🔄 **Real-time Updates**: Buttons change color based on selection state

## App Categories

- 🌐 **Browsers**: Chrome, Firefox, Edge, Brave, Opera
- 💬 **Messaging & Communication**: Zoom, Skype, Discord, Teams, Slack
- 🎵 **Media & Entertainment**: VLC, iTunes, Spotify, Winamp
- 🔒 **Security**: Avast, Malwarebytes, AVG
- ☁️ **Cloud Storage**: Dropbox, Google Drive, OneDrive
- 🔧 **Utilities**: CCleaner, TeamViewer, AnyDesk, ImgBurn
- 💻 **Development**: Notepad++, Python, FileZilla, VS Code
- 📄 **Documents**: LibreOffice, Foxit Reader, OpenOffice
- 🖼️ **Imaging & Design**: GIMP, Blender, Krita

## Technology Stack

- **Backend**: Node.js with Express.js
- **Frontend**: EJS templating, vanilla JavaScript
- **Styling**: CSS3 with responsive design
- **Icons**: Font Awesome + custom emoji icons
- **Server**: Ubuntu with nginx reverse proxy

## Installation

1. Clone the repository:
   ```bash
   git clone git@github.com:ryan5439/stackdrop.git
   cd stackdrop
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Start the application:
   ```bash
   npm start
   ```

4. Access the application at `http://localhost:3000`

## Development

The application structure:
- `app.js` - Main Express server
- `views/index.ejs` - Main template file
- `public/css/style.css` - Responsive styling
- `public/js/mainbutton.js` - Button interaction logic
- `public/images/` - Static assets and icons

## Mobile Features

- Sticky navigation header
- Fixed bottom button on mobile devices
- Responsive grid layout for app selection
- Touch-friendly interface elements

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## License

This project is licensed under the MIT License.

## Support

For support and feedback, please visit our website or create an issue in this repository.
