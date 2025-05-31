document.addEventListener('DOMContentLoaded', function() {
    const checkboxes = document.querySelectorAll('.app-checkbox');
    const generateBtn = document.getElementById('generate-btn-top');
    
    // Enable/disable button based on selection
    function updateButtonState() {
        const anyChecked = Array.from(checkboxes).some(checkbox => checkbox.checked);
        generateBtn.disabled = !anyChecked;
    }
    
    checkboxes.forEach(checkbox => {
        checkbox.addEventListener('change', updateButtonState);
    });
    
    // Handle form submission
    generateBtn.addEventListener('click', function() {
        const selectedApps = Array.from(checkboxes)
            .filter(checkbox => checkbox.checked)
            .map(checkbox => checkbox.value);
        
        if (selectedApps.length === 0) {
            alert('Please select at least one app to install.');
            return;
        }
        
        // Disable button and show loading state
        generateBtn.disabled = true;
        generateBtn.textContent = 'Generating...';
        
        // Send AJAX request
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
                    throw new Error(errorData.error || 'Network response was not ok');
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
        })
        .catch(error => {
            console.error('Error generating installer:', error);
            alert('Failed to generate installer. Please try again.\n' + error.message);
        })
        .finally(() => {
            // Re-enable button and reset text
            generateBtn.textContent = 'Generate Silent Installer';
            updateButtonState();
        });
    });
    
    // Initial button state update
    updateButtonState();
});