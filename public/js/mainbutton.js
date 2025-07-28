document.addEventListener('DOMContentLoaded', function() {
    const appCheckboxes = document.querySelectorAll('.js-homepage-app-checkbox');
    const generateBtns = document.querySelectorAll('.js-homepage-get-installer');
    
    // Function to update button state
    function updateButtonState() {
        const isAnyChecked = Array.from(appCheckboxes).some(checkbox => checkbox.checked);
        generateBtns.forEach(btn => {
            btn.disabled = !isAnyChecked;
        });
    }
    
    // Add event listeners to checkboxes
    appCheckboxes.forEach(checkbox => {
        checkbox.addEventListener('change', updateButtonState);
    });
    
    // Function to handle generate button click
    function handleGenerateClick(event) {
        event.preventDefault();
        
        // Get selected apps
        const selectedApps = Array.from(appCheckboxes)
            .filter(checkbox => checkbox.checked)
            .map(checkbox => checkbox.value);
        
        if (selectedApps.length === 0) {
            alert('Please select at least one app.');
            return;
        }
        
        // Disable buttons and show loading state
        generateBtns.forEach(btn => {
            btn.disabled = true;
            btn.textContent = 'Generating...';
        });
        
        // Make API request
        fetch('/generate', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ apps: selectedApps })
        })
        .then(response => {
            if (!response.ok) {
                return response.json().then(errorData => {
                    throw new Error(errorData.message || errorData.error || 'Network response was not ok');
                });
            }
            return response.blob();
        })
        .then(blob => {
            // Create download link
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.style.display = 'none';
            a.href = url;
            a.download = 'StackdropInstaller.exe';
            document.body.appendChild(a);
            a.click();
            window.URL.revokeObjectURL(url);
            
            // Reset buttons
            generateBtns.forEach(btn => {
                btn.textContent = 'Get Your Stackdrop Installer';
            });
            updateButtonState();
        })
        .catch(error => {
            console.error('Error:', error);
            alert('Failed to generate installer. Please try again.\n' + (error.message || 'Unknown error'));
            
            // Reset buttons
            generateBtns.forEach(btn => {
                btn.textContent = 'Get Your Stackdrop Installer';
            });
            updateButtonState();
        });
    }
    
    // Add event listeners to both buttons
    generateBtns.forEach(btn => {
        btn.addEventListener('click', handleGenerateClick);
    });
    
    // Initial button state
    updateButtonState();
});